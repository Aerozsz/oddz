type Level = "debug" | "info" | "warn" | "error";

type Fields = Record<string, unknown>;

function emit(level: Level, msg: string, fields?: Fields) {
  const line = { ts: new Date().toISOString(), level, msg, ...fields };
  const out = JSON.stringify(line);
  if (level === "error" || level === "warn") console.error(out);
  else console.log(out);
}

export const log = {
  debug: (msg: string, fields?: Fields) => {
    if (process.env.NODE_ENV !== "production") emit("debug", msg, fields);
  },
  info: (msg: string, fields?: Fields) => emit("info", msg, fields),
  warn: (msg: string, fields?: Fields) => emit("warn", msg, fields),
  error: (msg: string, fields?: Fields) => emit("error", msg, fields),
  child: (base: Fields) => ({
    debug: (msg: string, fields?: Fields) => log.debug(msg, { ...base, ...fields }),
    info: (msg: string, fields?: Fields) => log.info(msg, { ...base, ...fields }),
    warn: (msg: string, fields?: Fields) => log.warn(msg, { ...base, ...fields }),
    error: (msg: string, fields?: Fields) => log.error(msg, { ...base, ...fields }),
  }),
};
