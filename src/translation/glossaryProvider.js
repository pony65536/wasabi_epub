import { createAIProvider } from "./aiProvider.js";

const buildGlossaryModelProvider = ({ model, logger }) =>
    createAIProvider({
        primaryModel: model,
        fallbackModel: null,
        onContentPolicy: false,
        logger,
    });

export const createGlossaryProvider = ({
    logger,
    runtimeConfig,
    primaryProvider,
}) => {
    const defaultModel = runtimeConfig.models.glossaryDefault;
    const createDefaultProvider = () =>
        defaultModel.id === runtimeConfig.models.primary.id
            ? primaryProvider
            : buildGlossaryModelProvider({ model: defaultModel, logger });

    const languageModelId =
        runtimeConfig.models.glossaryBySourceLanguage[
            runtimeConfig.sourceLanguage
        ];
    if (!languageModelId) {
        return createDefaultProvider();
    }

    const resolution = runtimeConfig.resolveOptionalModel(languageModelId);
    if (!resolution.model) {
        logger.write(
            "WARN",
            `Glossary model "${languageModelId}" is unavailable (${resolution.unavailableReason}); falling back to "${defaultModel.id}".`,
        );
        return createDefaultProvider();
    }

    return buildGlossaryModelProvider({ model: resolution.model, logger });
};
