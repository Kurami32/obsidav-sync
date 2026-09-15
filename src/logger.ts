export type LogLevel = "debug" | "info" | "error";

class Logger {
    private level: LogLevel = "info";

    setLevel(level: LogLevel) {
        this.level = level;
    }

    debug(...args: unknown[]) {
        if (this.level === "debug") {
            console.log(...args);
        }
    }

    warn(...args: unknown[]) {
        if (this.level !== "error") {
            console.warn(...args);
        }
    }

    error(...args: unknown[]) {
        console.error(...args);
    }
}

export const logger = new Logger();