import crypto from "crypto";
import {
    MODEL_CONFIG_VERSION,
    MODEL_STAGES,
    loadModelConfig,
} from "./config.js";

/**
 * 阶段路由解析：
 * - CLI --model 只覆盖 translation 阶段
 * - 其它阶段：routing.stages[stage] > routing.primary
 * - fallback：stageFallback[stage]（显式 null 表示禁用）> routing.fallback
 * - 阶段只引用完整模型配置，不存在跨连接继承模型 ID
 */

export { MODEL_STAGES };

export const ADAPTER_VERSION = 1;

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

const resolveModelRef = ({ modelName, config, stage }) => {
    const model = config.models[modelName];
    if (!model) {
        throw new Error(
            `Stage "${stage}" references unknown model "${modelName}".`,
        );
    }
    const connection = config.connections[model.connection];
    if (!connection) {
        throw new Error(
            `Model "${modelName}" references unknown connection "${model.connection}".`,
        );
    }
    return { modelName, connectionName: model.connection, connection, model };
};

const snapshotRef = (ref) =>
    ref
        ? {
              modelName: ref.modelName,
              connectionName: ref.connectionName,
              connection: { ...ref.connection },
              model: { ...ref.model },
          }
        : null;

export const resolveModelRouting = ({
    projectRoot,
    env = process.env,
    cli = {},
    sourceLanguage,
} = {}) => {
    const config = loadModelConfig({ projectRoot, env, sourceLanguage });
    const warnings = [...(config.legacyWarnings || [])];
    const stages = {};

    for (const stage of MODEL_STAGES) {
        let modelName =
            config.routing.stages[stage] || config.routing.primary;
        if (stage === "translation" && cli.model) {
            if (!config.models[cli.model]) {
                throw new Error(
                    `CLI --model references unknown model "${cli.model}".`,
                );
            }
            modelName = cli.model;
        }

        const ref = resolveModelRef({ modelName, config, stage });

        const fallbackName = hasOwn(config.routing.stageFallback, stage)
            ? config.routing.stageFallback[stage]
            : config.routing.fallback;
        let fallbackRef = null;
        let fallbackCapabilityIssues = [];
        if (fallbackName) {
            fallbackRef = resolveModelRef({
                modelName: fallbackName,
                config,
                stage,
            });
            const required = config.routing.stageRequirements?.[stage] || [];
            fallbackCapabilityIssues = required.filter(
                (capability) => !fallbackRef.model[capability],
            );
            if (fallbackCapabilityIssues.length > 0) {
                warnings.push(
                    `Stage "${stage}" fallback "${fallbackName}" is missing: ${fallbackCapabilityIssues.join(", ")}; fallback disabled.`,
                );
            }
        }
        const usableFallback =
            fallbackRef && fallbackCapabilityIssues.length === 0
                ? fallbackRef
                : null;

        stages[stage] = {
            stage,
            modelName: ref.modelName,
            connectionName: ref.connectionName,
            connection: { ...ref.connection },
            model: { ...ref.model },
            fallback: snapshotRef(usableFallback),
            fallbackConfigured: fallbackName || null,
            fallbackCapabilityIssues,
        };
    }

    const fingerprint = computeRoutingFingerprint(stages, {
        fallbackOnContentPolicy: config.routing.fallbackOnContentPolicy,
    });

    return {
        version: config.version,
        source: config.source,
        primary: config.routing.primary,
        fallback: config.routing.fallback ?? null,
        fallbackOnContentPolicy:
            config.routing.fallbackOnContentPolicy ?? true,
        stages,
        fingerprint,
        warnings,
        describe: () => describeRouting(stages),
    };
};

const canonicalStage = (stage) =>
    stage
        ? {
              connection: {
                  url: stage.connection.url,
                  format: stage.connection.format,
                  tokenEnv: stage.connection.tokenEnv,
              },
              model: {
                  model: stage.model.model,
                  jsonMode: stage.model.jsonMode,
                  reasoning: stage.model.reasoning,
                  maxOutputTokens: stage.model.maxOutputTokens,
                  timeoutMs: stage.model.timeoutMs,
              },
              fallback: stage.fallback
                  ? {
                        connection: {
                            url: stage.fallback.connection.url,
                            format: stage.fallback.connection.format,
                            tokenEnv: stage.fallback.connection.tokenEnv,
                        },
                        model: {
                            model: stage.fallback.model.model,
                            jsonMode: stage.fallback.model.jsonMode,
                            reasoning: stage.fallback.model.reasoning,
                            maxOutputTokens:
                                stage.fallback.model.maxOutputTokens,
                            timeoutMs: stage.fallback.model.timeoutMs,
                        },
                    }
                  : null,
          }
        : null;

/**
 * 缓存身份指纹：覆盖所有影响译文的有效阶段配置（planner/translation/
 * director/glossary/memory/critic/headings）与 fallbackOnContentPolicy。
 * 含连接标识、模型、jsonMode、reasoning、输出预算、超时；不含密钥值。
 */
export const computeRoutingFingerprint = (
    stages,
    { fallbackOnContentPolicy = true } = {},
) => {
    const canonicalStages = {};
    for (const stage of MODEL_STAGES) {
        canonicalStages[stage] = canonicalStage(stages[stage]);
    }
    return crypto
        .createHash("sha1")
        .update(
            JSON.stringify({
                adapterVersion: ADAPTER_VERSION,
                configVersion: MODEL_CONFIG_VERSION,
                fallbackOnContentPolicy: Boolean(fallbackOnContentPolicy),
                stages: canonicalStages,
            }),
        )
        .digest("hex");
};

export const describeRouting = (stages) => {
    const summary = {};
    for (const [stage, info] of Object.entries(stages)) {
        summary[stage] = {
            modelName: info.modelName,
            connection: info.connectionName,
            format: info.connection.format,
            model: info.model.model,
            jsonMode: info.model.jsonMode,
            reasoning: info.model.reasoning,
            fallback: info.fallback
                ? {
                      modelName: info.fallback.modelName,
                      connection: info.fallback.connectionName,
                      model: info.fallback.model.model,
                  }
                : null,
            fallbackConfigured: info.fallbackConfigured,
        };
    }
    return summary;
};
