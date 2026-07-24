export function resolveRequestedAsrModel(requestedModel, defaultModel) {
  const requested = String(requestedModel || "").trim();
  return requested || String(defaultModel || "").trim();
}
