export const shouldRetainArtifacts = ({
    completed,
    debugMode,
    retainOnFailure,
}) => Boolean(debugMode) || (!completed && Boolean(retainOnFailure));
