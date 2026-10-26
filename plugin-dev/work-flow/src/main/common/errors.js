// Domain errors carry a stable code so the UI can explain failures without parsing localized messages.
export function fail(code, message) {
  return Object.assign(Error(message), { code });
}
