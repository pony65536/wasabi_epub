import fs from "fs";
import os from "os";
import path from "path";
import {
    loadModelConfig,
    normalizeModelConfig,
} from "../src/models/config.js";
import { resolveModelRouting } from "../src/models/routing.js";

const assert = (condition, message) => {
    if (!condition) throw new Error(message);
};

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wasabi-models-"));
const emptyDir = path.join(tmpRoot, "empty");
fs.mkdirSync(emptyDir, { recursive: true });

const writeConfig = (name, config) => {
    const dir = path.join(tmpRoot, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
        path.join(dir, "models.json"),
        JSON.stringify(config, null, 2),
        "utf8",
    );
    return dir;
};

const BASE_CONFIG = {
    connections: {
        main: {
            url: "https://relay.example/v1",
            format: "openai-chat",
            tokenEnv: "MODEL_API_KEY",
            concurrency: 3,
            timeoutMs: 60000,
        },
    },
    models: {
        normal: { connection: "main", model: "model-A", jsonMode: true },
        careful: {
            connection: "main",
            model: "model-B",
            jsonMode: true,
            reasoning: false,
            maxOutputTokens: 2048,
        },
        backup: { connection: "main", model: "model-C", jsonMode: true },
    },
    routing: {
        primary: "normal",
        fallback: "backup",
        stages: { critic: "careful" },
        stageFallback: { critic: null },
        stageRequirements: { critic: ["jsonMode"] },
    },
};

const run = () => {
    console.log("=== legacy env 合成与阶段回落 ===");
    const legacyEnv = {
        PRIMARY_PROVIDER: "qwen",
        PRIMARY_MODEL: "model-x",
        QWEN_API_KEY: "key-1",
        FALLBACK_PROVIDER: "openrouter",
        FALLBACK_MODEL: "model-y",
        OPENROUTER_API_KEY: "key-2",
        OPENROUTER_REASONING_ENABLED: "false",
    };
    const legacy = resolveModelRouting({
        projectRoot: emptyDir,
        env: legacyEnv,
    });
    assert(legacy.source === "legacy-env", "legacy source expected");
    assert(
        legacy.stages.translation.model.model === "model-x" &&
            legacy.stages.translation.model.jsonMode === true,
        "legacy primary model must resolve",
    );
    assert(
        legacy.stages.translation.fallback?.model.model === "model-y" &&
            legacy.stages.translation.fallback.model.reasoning === false,
        "legacy fallback + reasoning flag must resolve",
    );
    assert(
        legacy.stages.critic.model.model === "model-x",
        "unconfigured stage must fall back to primary",
    );
    assert(
        legacy.stages.critic.fallback?.model.model === "model-y",
        "unconfigured stage fallback must fall back to routing fallback",
    );
    console.log("✅ legacy synthesis and stage fallback");

    console.log("\n=== legacy 俄语 glossary 特例 ===");
    const ruRouting = resolveModelRouting({
        projectRoot: emptyDir,
        env: {
            ...legacyEnv,
            RUSSIAN_GLOSSARY_PROVIDER: "openrouter",
            RUSSIAN_GLOSSARY_MODEL: "ru-model",
        },
        sourceLanguage: "Russian",
    });
    assert(
        ruRouting.stages.glossary.model.model === "ru-model",
        "Russian glossary model must be routed to glossary stage",
    );
    assert(
        ruRouting.stages.translation.model.model === "model-x",
        "glossary override must not change translation",
    );
    const noKeyRouting = resolveModelRouting({
        projectRoot: emptyDir,
        env: { ...legacyEnv, OPENROUTER_API_KEY: "" },
        sourceLanguage: "Russian",
    });
    assert(
        noKeyRouting.stages.glossary.model.model === "model-x",
        "glossary must fall back to primary when provider key is missing",
    );
    console.log("✅ legacy glossary special case preserved");

    console.log("\n=== models.json 解析与阶段覆盖 ===");
    const dir = writeConfig("base", BASE_CONFIG);
    const routing = resolveModelRouting({ projectRoot: dir, env: {} });
    assert(
        routing.stages.critic.model.model === "model-B" &&
            routing.stages.critic.fallback === null,
        "critic stage must use careful and explicit null fallback",
    );
    assert(
        routing.stages.translation.fallback?.model.model === "model-C",
        "translation fallback must resolve to backup",
    );
    assert(
        routing.stages.memory.model.model === "model-A",
        "memory must fall back to primary",
    );
    assert(
        routing.stages.translation.connection.url ===
            "https://relay.example/v1",
        "connection url must be preserved",
    );
    console.log("✅ models.json parsing and per-stage routing");

    console.log("\n=== CLI --model 只覆盖 translation ===");
    const cliRouting = resolveModelRouting({
        projectRoot: dir,
        env: {},
        cli: { model: "careful" },
    });
    assert(
        cliRouting.stages.translation.model.model === "model-B",
        "CLI model must override translation",
    );
    assert(
        cliRouting.stages.memory.model.model === "model-A" &&
            cliRouting.stages.director.model.model === "model-A",
        "CLI model must not affect other stages",
    );
    assert(
        cliRouting.stages.translation.fallback?.model.model === "model-C",
        "CLI model must not change fallback",
    );
    let cliUnknownThrown = false;
    try {
        resolveModelRouting({
            projectRoot: dir,
            env: {},
            cli: { model: "missing-model" },
        });
    } catch (error) {
        cliUnknownThrown = /unknown model/.test(error.message);
    }
    assert(cliUnknownThrown, "unknown CLI model must fail fast");
    console.log("✅ CLI override scope enforced");

    console.log("\n=== 非法引用在解析期失败 ===");
    let stageRefThrown = false;
    try {
        normalizeModelConfig(
            {
                ...BASE_CONFIG,
                routing: {
                    ...BASE_CONFIG.routing,
                    stages: { critic: "ghost" },
                },
            },
            { source: "test" },
        );
    } catch (error) {
        stageRefThrown = /unknown model "ghost"/.test(error.message);
    }
    assert(stageRefThrown, "unknown stage model must throw");

    let connectionRefThrown = false;
    try {
        normalizeModelConfig(
            {
                ...BASE_CONFIG,
                models: {
                    normal: { connection: "ghost", model: "A" },
                },
            },
            { source: "test" },
        );
    } catch (error) {
        connectionRefThrown = /unknown connection "ghost"/.test(error.message);
    }
    assert(connectionRefThrown, "unknown connection must throw");

    let formatThrown = false;
    try {
        normalizeModelConfig(
            {
                ...BASE_CONFIG,
                connections: {
                    main: {
                        url: "https://x",
                        format: "carrier-pigeon",
                        tokenEnv: "K",
                    },
                },
            },
            { source: "test" },
        );
    } catch (error) {
        formatThrown = /unsupported format/.test(error.message);
    }
    assert(formatThrown, "unsupported format must throw");
    console.log("✅ invalid references fail at parse time");

    console.log("\n=== routing 指纹 ===");
    const fp1 = resolveModelRouting({ projectRoot: dir, env: {} }).fingerprint;
    const fp2 = resolveModelRouting({ projectRoot: dir, env: {} }).fingerprint;
    assert(fp1 === fp2, "fingerprint must be stable");
    assert(
        resolveModelRouting({
            projectRoot: dir,
            env: { MODEL_API_KEY: "secret-one" },
        }).fingerprint ===
            resolveModelRouting({
                projectRoot: dir,
                env: { MODEL_API_KEY: "secret-two" },
            }).fingerprint,
        "fingerprint must not include secret values",
    );

    const changeModelDir = writeConfig("change-model", {
        ...BASE_CONFIG,
        models: {
            ...BASE_CONFIG.models,
            normal: { ...BASE_CONFIG.models.normal, model: "model-A2" },
        },
    });
    assert(
        resolveModelRouting({ projectRoot: changeModelDir, env: {} })
            .fingerprint !== fp1,
        "changing translation model must change fingerprint",
    );

    const changeReasoningDir = writeConfig("change-reasoning", {
        ...BASE_CONFIG,
        models: {
            ...BASE_CONFIG.models,
            normal: {
                ...BASE_CONFIG.models.normal,
                reasoning: true,
            },
        },
    });
    assert(
        resolveModelRouting({ projectRoot: changeReasoningDir, env: {} })
            .fingerprint !== fp1,
        "changing reasoning must change fingerprint",
    );

    const changeBudgetDir = writeConfig("change-budget", {
        ...BASE_CONFIG,
        models: {
            ...BASE_CONFIG.models,
            normal: {
                ...BASE_CONFIG.models.normal,
                maxOutputTokens: 8192,
            },
        },
    });
    assert(
        resolveModelRouting({ projectRoot: changeBudgetDir, env: {} })
            .fingerprint !== fp1,
        "changing output budget must change fingerprint",
    );

    const changeConnectionDir = writeConfig("change-connection", {
        ...BASE_CONFIG,
        connections: {
            main: {
                ...BASE_CONFIG.connections.main,
                url: "https://other.example/v1",
            },
        },
    });
    assert(
        resolveModelRouting({ projectRoot: changeConnectionDir, env: {} })
            .fingerprint !== fp1,
        "changing connection url must change fingerprint",
    );

    const changeCriticDir = writeConfig("change-critic", {
        ...BASE_CONFIG,
        routing: {
            ...BASE_CONFIG.routing,
            stages: { critic: "backup" },
        },
    });
    assert(
        resolveModelRouting({ projectRoot: changeCriticDir, env: {} })
            .fingerprint !== fp1,
        "critic model change must change fingerprint (critic edits translations)",
    );

    const changeGlossaryDir = writeConfig("change-glossary", {
        ...BASE_CONFIG,
        routing: {
            ...BASE_CONFIG.routing,
            stages: { ...BASE_CONFIG.routing.stages, glossary: "backup" },
        },
    });
    assert(
        resolveModelRouting({ projectRoot: changeGlossaryDir, env: {} })
            .fingerprint !== fp1,
        "glossary model change must change fingerprint",
    );

    const changePolicyDir = writeConfig("change-policy", {
        ...BASE_CONFIG,
        routing: {
            ...BASE_CONFIG.routing,
            fallbackOnContentPolicy: false,
        },
    });
    assert(
        resolveModelRouting({ projectRoot: changePolicyDir, env: {} })
            .fingerprint !== fp1,
        "fallbackOnContentPolicy change must change fingerprint",
    );
    console.log(
        "✅ fingerprint covers all stages affecting translation, excludes secrets",
    );

    console.log("\n=== fallback 能力校验 ===");
    const weakFallbackDir = writeConfig("weak-fallback", {
        ...BASE_CONFIG,
        models: {
            ...BASE_CONFIG.models,
            backup: { connection: "main", model: "model-C", jsonMode: false },
        },
        routing: {
            ...BASE_CONFIG.routing,
            stages: { critic: "careful" },
            stageFallback: { critic: "backup" },
            stageRequirements: { critic: ["jsonMode"] },
        },
    });
    const weak = resolveModelRouting({
        projectRoot: weakFallbackDir,
        env: {},
    });
    assert(
        weak.stages.critic.fallback === null &&
            weak.stages.critic.fallbackCapabilityIssues.includes("jsonMode"),
        "fallback missing required capability must be disabled with issue",
    );
    console.log("✅ fallback capability validation");

    console.log("\n=== WASABI_MODELS_FILE 显式路径 ===");
    const explicit = resolveModelRouting({
        projectRoot: emptyDir,
        env: { WASABI_MODELS_FILE: path.join(dir, "models.json") },
    });
    assert(
        explicit.source.endsWith("models.json") &&
            explicit.stages.translation.model.model === "model-A",
        "explicit config file must be loaded",
    );
    console.log("✅ explicit config file loading");

    console.log("\n=== loadModelConfig 形状 ===");
    const loaded = loadModelConfig({ projectRoot: dir, env: {} });
    assert(
        loaded.version === 1 &&
            loaded.connections.main.format === "openai-chat" &&
            loaded.models.normal.connection === "main",
        "normalized config shape",
    );
    console.log("✅ normalized config shape");

    console.log("\n=== 显式配置文件缺失必须报错 ===");
    let missingFileThrown = false;
    try {
        resolveModelRouting({
            projectRoot: emptyDir,
            env: {
                WASABI_MODELS_FILE: path.join(emptyDir, "does-not-exist.json"),
            },
        });
    } catch (error) {
        missingFileThrown = /missing file/.test(error.message);
    }
    assert(
        missingFileThrown,
        "WASABI_MODELS_FILE pointing to a missing file must throw",
    );
    console.log("✅ explicit missing config file fails fast");

    console.log("\n=== legacy 同连接主备模型保留 ===");
    const sameConnRouting = resolveModelRouting({
        projectRoot: emptyDir,
        env: {
            PRIMARY_PROVIDER: "openrouter",
            PRIMARY_MODEL: "model-A",
            OPENROUTER_API_KEY: "k",
            FALLBACK_PROVIDER: "openrouter",
            FALLBACK_MODEL: "model-B",
        },
    });
    assert(
        sameConnRouting.stages.translation.fallback?.model.model === "model-B",
        "same-connection fallback with a different model must be kept",
    );
    const sameModelRouting = resolveModelRouting({
        projectRoot: emptyDir,
        env: {
            PRIMARY_PROVIDER: "openrouter",
            PRIMARY_MODEL: "model-A",
            OPENROUTER_API_KEY: "k",
            FALLBACK_PROVIDER: "openrouter",
            FALLBACK_MODEL: "model-A",
        },
    });
    assert(
        sameModelRouting.stages.translation.fallback === null,
        "identical primary/fallback model must not create a duplicate fallback",
    );
    console.log("✅ legacy same-connection fallback preserved");

    console.log("\n=== legacy fallbackOnContentPolicy 与模型 env 优先级 ===");
    const policyRouting = resolveModelRouting({
        projectRoot: emptyDir,
        env: {
            PRIMARY_PROVIDER: "qwen",
            PRIMARY_MODEL: "model-x",
            QWEN_API_KEY: "k",
            FALLBACK_ON_CONTENT_POLICY: "false",
        },
    });
    assert(
        policyRouting.fallbackOnContentPolicy === false,
        "FALLBACK_ON_CONTENT_POLICY=false must be preserved",
    );
    const precedenceRouting = resolveModelRouting({
        projectRoot: emptyDir,
        env: {
            PRIMARY_PROVIDER: "qwen",
            PRIMARY_MODEL: "from-primary",
            QWEN_MODEL: "from-provider",
            QWEN_API_KEY: "k",
        },
    });
    assert(
        precedenceRouting.stages.translation.model.model === "from-provider",
        "<PROVIDER>_MODEL must take precedence over PRIMARY_MODEL",
    );
    assert(
        precedenceRouting.warnings.some((warning) =>
            warning.includes("precedence"),
        ),
        "precedence change must produce a migration warning",
    );
    console.log("✅ legacy policy and model env precedence");

    console.log("\n=== 严格类型与未知阶段校验 ===");
    const expectThrow = (fn, pattern, label) => {
        let matched = false;
        try {
            fn();
        } catch (error) {
            matched = pattern.test(error.message);
        }
        assert(matched, label);
    };
    expectThrow(
        () =>
            normalizeModelConfig(
                {
                    ...BASE_CONFIG,
                    models: {
                        ...BASE_CONFIG.models,
                        normal: {
                            ...BASE_CONFIG.models.normal,
                            reasoning: "false",
                        },
                    },
                },
                { source: "test" },
            ),
        /reasoning must be a boolean/,
        "string reasoning must be rejected",
    );
    expectThrow(
        () =>
            normalizeModelConfig(
                {
                    ...BASE_CONFIG,
                    models: {
                        ...BASE_CONFIG.models,
                        normal: {
                            ...BASE_CONFIG.models.normal,
                            maxOutputTokens: -1,
                        },
                    },
                },
                { source: "test" },
            ),
        /maxOutputTokens must be a positive integer/,
        "negative output budget must be rejected",
    );
    expectThrow(
        () =>
            normalizeModelConfig(
                {
                    ...BASE_CONFIG,
                    routing: {
                        ...BASE_CONFIG.routing,
                        stages: { critc: "normal" },
                    },
                },
                { source: "test" },
            ),
        /unknown stage "critc"/,
        "misspelled stage must be rejected",
    );
    expectThrow(
        () =>
            normalizeModelConfig(
                {
                    ...BASE_CONFIG,
                    routing: {
                        ...BASE_CONFIG.routing,
                        stageRequirements: { critic: ["jsonModes"] },
                    },
                },
                { source: "test" },
            ),
        /unknown capability "jsonModes"/,
        "unknown capability must be rejected",
    );
    console.log("✅ strict type and stage validation");

    console.log("\nAll model-routing audits passed.");
};

try {
    run();
} catch (error) {
    console.error(`\n❌ MODEL ROUTING AUDIT FAILED: ${error.message}`);
    process.exit(1);
}
