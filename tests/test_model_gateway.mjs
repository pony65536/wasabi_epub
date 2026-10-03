import fs from "fs";
import os from "os";
import path from "path";
import { resolveModelRouting } from "../src/models/routing.js";
import {
    createModelGateway,
    defaultCreateAdapter,
} from "../src/models/gateway.js";

const assert = (condition, message) => {
    if (!condition) throw new Error(message);
};

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wasabi-gateway-"));

const writeRouting = (name, routingOverrides = {}, modelOverrides = {}) => {
    const dir = path.join(tmpRoot, name);
    fs.mkdirSync(dir, { recursive: true });
    const config = {
        connections: {
            main: {
                url: "http://127.0.0.1:1/v1",
                format: "openai-chat",
                tokenEnv: "MODEL_API_KEY",
                concurrency: 1,
                timeoutMs: 5000,
            },
        },
        models: {
            primary: {
                connection: "main",
                model: "model-A",
                jsonMode: true,
                maxOutputTokens: 1024,
                ...modelOverrides.primary,
            },
            backup: {
                connection: "main",
                model: "model-B",
                jsonMode: true,
                ...modelOverrides.backup,
            },
        },
        routing: {
            primary: "primary",
            fallback: "backup",
            stages: { translation: "primary", critic: "primary" },
            ...routingOverrides,
        },
    };
    fs.writeFileSync(
        path.join(dir, "models.json"),
        JSON.stringify(config, null, 2),
        "utf8",
    );
    return resolveModelRouting({ projectRoot: dir, env: {} });
};

const createFakeFactory = ({ scripts, calls, onCall }) => ({
    connectionName,
    model,
}) => ({
    providerName: connectionName,
    modelName: model.model,
    async call(request) {
        calls.push({
            model: model.model,
            connection: connectionName,
            json: request.json,
            maxOutputTokens: request.maxOutputTokens,
        });
        if (onCall) await onCall(request);
        const script = scripts.get(model.model);
        if (Array.isArray(script) && script.length > 0) {
            const step = script.length === 1 ? script[0] : script.shift();
            if (step.error) {
                const error = new Error(
                    step.error.message || "provider error",
                );
                if (step.error.status) error.status = step.error.status;
                if (step.error.code) error.code = step.error.code;
                throw error;
            }
            return { text: step.text ?? "ok", usage: step.usage || null };
        }
        return { text: "ok", usage: null };
    },
});

const makeGateway = (routing, options = {}) => {
    const scripts = new Map();
    const calls = [];
    const gateway = createModelGateway({
        routing,
        env: { MODEL_API_KEY: "test-key" },
        retryDelayMs: 1,
        createAdapter: createFakeFactory({
            scripts,
            calls,
            onCall: options.onCall,
        }),
        ...options,
    });
    return { gateway, scripts, calls };
};

const run = async () => {
    console.log("=== 同模型有界重试 ===");
    {
        const routing = writeRouting("retry");
        const { gateway, scripts, calls } = makeGateway(routing);
        scripts.set("model-A", [
            { error: { status: 429, message: "rate limit" } },
            { text: "recovered" },
        ]);
        const result = await gateway.call("translation", {
            system: "s",
            user: "u",
        });
        assert(result.text === "recovered", "retry must recover");
        assert(
            calls.length === 2 &&
                calls.every((call) => call.model === "model-A"),
            "retry must stay on the same model",
        );
        console.log("✅ bounded same-model retry");
    }

    console.log("\n=== 永久错误快速失败 ===");
    {
        const routing = writeRouting("auth", { fallback: null });
        const { gateway, scripts, calls } = makeGateway(routing);
        scripts.set("model-A", [{ error: { status: 401 } }]);
        let error = null;
        try {
            await gateway.call("translation", { system: "s", user: "u" });
        } catch (caught) {
            error = caught;
        }
        assert(
            error?.category === "auth" && calls.length === 1,
            `auth must fail fast, calls=${calls.length}`,
        );
        console.log("✅ non-retryable errors fail fast");
    }

    console.log("\n=== 同连接主备切换 ===");
    {
        const routing = writeRouting("fallback");
        const { gateway, scripts, calls } = makeGateway(routing);
        scripts.set("model-A", [
            { error: { message: "content policy violation" } },
        ]);
        scripts.set("model-B", [{ text: "fallback-text" }]);
        const result = await gateway.call("translation", {
            system: "s",
            user: "u",
        });
        assert(
            result.text === "fallback-text" &&
                calls.some((call) => call.model === "model-B"),
            "content policy must trigger fallback to model-B",
        );
        console.log("✅ same-connection fallback actually called");
    }

    console.log("\n=== fallbackOnContentPolicy=false 禁止候补 ===");
    {
        const routing = writeRouting("no-policy-fallback", {
            fallbackOnContentPolicy: false,
        });
        const { gateway, scripts, calls } = makeGateway(routing);
        scripts.set("model-A", [
            { error: { message: "content policy violation" } },
        ]);
        let error = null;
        try {
            await gateway.call("translation", { system: "s", user: "u" });
        } catch (caught) {
            error = caught;
        }
        assert(
            error?.category === "content_policy" &&
                !calls.some((call) => call.model === "model-B"),
            "policy=false must keep the request on the primary model",
        );
        console.log("✅ content-policy fallback can be disabled");
    }

    console.log("\n=== 格式错误不触发候补 ===");
    {
        const routing = writeRouting("format");
        const { gateway, scripts, calls } = makeGateway(routing);
        scripts.set("model-A", [{ error: { message: "invalid json output" } }]);
        let error = null;
        try {
            await gateway.call("translation", { system: "s", user: "u" });
        } catch (caught) {
            error = caught;
        }
        assert(
            error?.category === "format" &&
                calls.length === 2 &&
                !calls.some((call) => call.model === "model-B"),
            "format errors must retry then stop, without fallback",
        );
        console.log("✅ format errors do not fall back");
    }

    console.log("\n=== 任务成本上限 ===");
    {
        const routing = writeRouting("budget", { fallback: null });
        const { gateway, scripts } = makeGateway(routing, {
            maxFailedRequests: 2,
        });
        scripts.set("model-A", [{ error: { status: 429 } }]);
        let first = null;
        try {
            await gateway.call("translation", { system: "s", user: "u" });
        } catch (caught) {
            first = caught;
        }
        assert(first?.category === "rate_limit", "first call fails on rate limit");
        let second = null;
        try {
            await gateway.call("translation", { system: "s", user: "u" });
        } catch (caught) {
            second = caught;
        }
        assert(
            second?.code === "TASK_COST_LIMIT_REACHED",
            `second call must hit the cost limit, got ${second?.code}`,
        );
        console.log("✅ task cost limit stops new requests");
    }

    console.log("\n=== 连续故障阈值与成功清零 ===");
    {
        const routing = writeRouting("consecutive", { fallback: null });
        const { gateway, scripts, calls } = makeGateway(routing, {
            maxFailedRequests: 100,
            consecutiveFailureThreshold: 2,
        });
        scripts.set("model-A", [
            { error: { status: 429 } },
            { text: "ok" },
            { error: { status: 429 } },
            { error: { status: 429 } },
        ]);
        const ok = await gateway.call("translation", { system: "s", user: "u" });
        assert(ok.text === "ok", "success after a failure must reset counter");
        let failed = null;
        try {
            await gateway.call("translation", { system: "s", user: "u" });
        } catch (caught) {
            failed = caught;
        }
        assert(failed?.category === "rate_limit", "second call must fail");
        let stopped = null;
        try {
            await gateway.call("translation", { system: "s", user: "u" });
        } catch (caught) {
            stopped = caught;
        }
        assert(
            stopped?.code === "CONSECUTIVE_FAILURES",
            `consecutive failures must stop the task, got ${stopped?.code}`,
        );
        assert(
            calls.length === 4,
            `no extra requests after stop, calls=${calls.length}`,
        );
        console.log("✅ consecutive-failure threshold with reset on success");
    }

    console.log("\n=== 双层并发（全局 + 连接）===");
    {
        const routing = writeRouting("limits");
        let active = 0;
        let maxActive = 0;
        const { gateway, scripts } = makeGateway(routing, {
            globalConcurrency: 1,
            connectionConcurrency: 1,
            onCall: async () => {
                active += 1;
                maxActive = Math.max(maxActive, active);
                await new Promise((resolve) => setTimeout(resolve, 20));
                active -= 1;
            },
        });
        scripts.set("model-A", [{ text: "ok" }]);
        const stage = gateway.forStage("translation");
        await Promise.all([
            stage.callAI("u1", "s"),
            stage.callAI("u2", "s"),
            gateway.forStage("critic").callAI("u3", "s"),
        ]);
        assert(
            maxActive === 1,
            `global+connection limit must serialize, saw ${maxActive}`,
        );
        const limiterStats = stage.getLimiterStats();
        assert(
            limiterStats.global.active === 0 &&
                limiterStats.connection.active === 0,
            "limiters must drain",
        );
        console.log("✅ global + per-connection scheduling");
    }

    console.log("\n=== 请求参数与 usage 记账 ===");
    {
        const routing = writeRouting("params");
        const { gateway, scripts, calls } = makeGateway(routing);
        scripts.set("model-A", [
            {
                text: "ok",
                usage: { prompt_tokens: 10, completion_tokens: 5 },
            },
        ]);
        await gateway.call("translation", { system: "s", user: "u", json: true });
        await gateway.call("translation", {
            system: "s",
            user: "u",
            json: true,
            maxOutputTokens: 2048,
        });
        assert(
            calls[0].json === true && calls[0].maxOutputTokens === 1024,
            "model output budget must be applied",
        );
        assert(
            calls[1].maxOutputTokens === 2048,
            "explicit budget must override model default",
        );
        const usage = gateway.usage();
        assert(
            usage.requests === 2 &&
                usage.byStage.translation === 2 &&
                usage.byModel["main:model-A"] === 2 &&
                usage.tokens.prompt === 20 &&
                usage.tokens.completion === 10,
            `usage accounting mismatch: ${JSON.stringify(usage)}`,
        );
        console.log("✅ request params and usage accounting");
    }

    console.log("\n=== forStage 形状与缺 key 报错 ===");
    {
        const routing = writeRouting("stage-shape");
        const { gateway } = makeGateway(routing);
        const stage = gateway.forStage("translation");
        assert(
            stage.providerName === "main" &&
                stage.modelName === "model-A" &&
                stage.fallbackProviderName === "main" &&
                typeof stage.callAI === "function",
            "forStage must expose provider/model/fallback",
        );

        const noKeyGateway = createModelGateway({
            routing,
            env: {},
            createAdapter: defaultCreateAdapter,
        });
        let error = null;
        try {
            await noKeyGateway.call("translation", { system: "s", user: "u" });
        } catch (caught) {
            error = caught;
        }
        assert(
            error?.category === "auth" && error?.code === "MISSING_API_KEY",
            `missing key must fail as auth, got ${error?.code}`,
        );
        console.log("✅ forStage shape and missing-key failure");
    }

    console.log("\nAll model-gateway audits passed.");
};

run().catch((error) => {
    console.error(`\n❌ MODEL GATEWAY AUDIT FAILED: ${error.message}`);
    process.exit(1);
});
