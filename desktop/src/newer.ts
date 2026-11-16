/**
 * What ICMM says of a file or config a newer ICMM saved: it names this
 * ICMM's version (DS14, #168), on Import and on Configs (CF16).
 */
export const newerWords = (name: string) =>
  `This is ICMM ${__APP_VERSION__}; ${name} needs a newer one.`;
