import path from "path";

import { createJobCache, finalizeJobArtifacts } from "../support/jobRuntime.js";
import { ensureDir } from "../support/files.js";
import { createLogger } from "../support/logger.js";
import { createModelGateway } from "../models/gateway.js";
import { resolveModelRouting } from "../models/routing.js";
import { createBatchQueue } from "../translation/batchQueue.js";
import { shouldRetainArtifacts } from "./artifactPolicy.js";

export const createJobContext = ({
    projectRoot, inputPath, runtimeConfig, debugMode, cacheDir, modelName = runtimeConfig.modelOverride,
    createAdapter,
}) => {
    modelName = modelName || runtimeConfig.modelOverride || null;
    const logDir = path.resolve(projectRoot, "log");
    const inputDir = path.resolve(projectRoot, "input");
    const outputDir = path.resolve(projectRoot, "output");
    for (const dir of [logDir, inputDir, outputDir]) ensureDir(dir);
    const logger = createLogger(logDir);
    let cache;
    try {
        const routing = resolveModelRouting({
            projectRoot, config: runtimeConfig.modelConfig,
            env: runtimeConfig.getModelEnvironment?.() || process.env,
            cli: { model: modelName || undefined },
            sourceLanguage: runtimeConfig.sourceLanguage,
        });
        const gateway = createModelGateway({
            routing, logger,
            env: runtimeConfig.getModelEnvironment?.() || process.env,
            globalConcurrency: runtimeConfig.concurrencyOverride || null,
            connectionConcurrency: runtimeConfig.concurrencyOverride || null,
            ...(createAdapter ? { createAdapter } : {}),
        });
        for (const warning of [...(runtimeConfig.warnings || []), ...(routing.warnings || [])]) {
            logger.write("WARN", warning);
        }
        const aiProvider = gateway.forStage("translation");
        const batchQueue = createBatchQueue(aiProvider, logger);
        cache = createJobCache(cacheDir);
        const getGlossaryProvider = () => {
            const selection = runtimeConfig.modelSelection;
            const languageId = runtimeConfig.models?.glossaryBySourceLanguage[runtimeConfig.sourceLanguage];
            let id = selection?.stages.glossary || runtimeConfig.models?.glossaryDefault.id;
            if (languageId) {
                const optional = runtimeConfig.resolveOptionalModel(languageId);
                if (optional.model) id = languageId;
                else logger.write("WARN", `Glossary model "${languageId}" is unavailable; using default glossary model.`);
            }
            if (id && id !== routing.stages.glossary.modelName) {
                const glossaryConfig = {
                    ...runtimeConfig.modelConfig,
                    routing: { ...runtimeConfig.modelConfig.routing,
                        stages: { ...runtimeConfig.modelConfig.routing.stages, glossary: id } },
                };
                const refreshed = resolveModelRouting({ config: glossaryConfig, cli: { model: modelName || undefined } });
                routing.stages.glossary = refreshed.stages.glossary;
                routing.fingerprint = refreshed.fingerprint;
            }
            return gateway.forStage("glossary");
        };
        return { projectRoot, inputPath, runtimeConfig, debugMode, logDir, inputDir,
            outputDir, logger, gateway, aiProvider, batchQueue, cache, cacheDir,
            get glossaryProvider() { return getGlossaryProvider(); },
            getGlossaryProvider,
        };
    } catch (error) {
        cache?.releaseTaskLock();
        logger.write("ERROR", `Job initialization failed: ${error.message}`);
        throw error;
    }
};

export const formatRoutingSummary = (gateway) => Object.entries(gateway.describe() || {})
    .map(([stage, info]) => `${stage}=${info.model}@${info.connection}${info.fallback ? `->${info.fallback.model}` : ""}`)
    .join("  ");

export const printJobBanner = (ctx, { inputIcon, inputName, outputName,
    htmlName = null, pageSelector = null, chapterSelector = null }) => {
    console.log("\n========================================");
    console.log(`${inputIcon} Input:  ${inputName}`);
    console.log(`💾 Output: ${outputName}`);
    if (htmlName) console.log(`📄 HTML:   ${htmlName}`);
    console.log(`📦 Cache:  ${path.basename(ctx.cacheDir)}`);
    console.log(`🐞 Debug: ${ctx.debugMode ? "on" : "off"}`);
    console.log(`🗣️ Source: ${ctx.runtimeConfig.sourceLanguage}`);
    console.log(`🌐 Target: ${ctx.runtimeConfig.targetLanguage}`);
    console.log(`⚙️ Concurrency: ${ctx.aiProvider.concurrency}`);
    if (pageSelector) console.log(`📄 Pages: ${pageSelector}`);
    console.log(`🤖 Provider: ${ctx.aiProvider.providerName} (${ctx.aiProvider.modelName})`);
    console.log(`🧭 Routing: ${formatRoutingSummary(ctx.gateway)}`);
    if (chapterSelector) console.log(`🎯 Chapters: ${chapterSelector}`);
    console.log("========================================\n");
};

export const finishJob = (ctx, { completed = false, translationStatus = "complete", validationStatus = "ok",
    keepArtifacts = shouldRetainArtifacts({ completed, debugMode: ctx.debugMode, translationStatus, validationStatus }) } = {}) =>
    finalizeJobArtifacts({ cache: ctx.cache, logger: ctx.logger,
        debugMode: ctx.debugMode, keepArtifacts });
