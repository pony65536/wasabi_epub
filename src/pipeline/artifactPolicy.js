export const shouldRetainArtifacts = ({
    completed,
    debugMode,
    translationStatus = "complete",
    validationStatus = "ok",
}) => Boolean(debugMode) || !completed || translationStatus !== "complete" || validationStatus !== "ok";
