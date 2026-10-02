import { spawn } from "child_process";

const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

const appendCapped = (current, chunk, maxBytes) => {
    if (current.length >= maxBytes) return current;
    const text = String(chunk);
    const remaining = maxBytes - current.length;
    return current + text.slice(0, remaining);
};

/**
 * 统一子进程执行器：参数数组、cwd、超时、取消、输出上限、结构化退出原因。
 * 不抛出：返回 { code, stdout, stderr, timedOut, aborted }。
 */
export const runProcess = (
    command,
    args = [],
    options = {},
) =>
    new Promise((resolve, reject) => {
        const {
            cwd = undefined,
            env = process.env,
            timeoutMs = 0,
            maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
            signal = null,
        } = options;

        let child;
        try {
            child = spawn(command, args, {
                cwd,
                env,
                windowsHide: true,
            });
        } catch (error) {
            error.category = "spawn";
            reject(error);
            return;
        }

        let stdout = "";
        let stderr = "";
        let timedOut = false;
        let aborted = false;
        let settled = false;

        let timer = null;
        const cleanup = () => {
            if (timer) clearTimeout(timer);
            if (signal) signal.removeEventListener("abort", onAbort);
        };
        const onAbort = () => {
            aborted = true;
            child.kill("SIGKILL");
        };

        if (timeoutMs > 0) {
            timer = setTimeout(() => {
                timedOut = true;
                child.kill("SIGKILL");
            }, timeoutMs);
        }
        if (signal) {
            if (signal.aborted) onAbort();
            else signal.addEventListener("abort", onAbort, { once: true });
        }

        child.stdout?.on("data", (chunk) => {
            stdout = appendCapped(stdout, chunk, maxOutputBytes);
        });
        child.stderr?.on("data", (chunk) => {
            stderr = appendCapped(stderr, chunk, maxOutputBytes);
        });
        child.on("error", (error) => {
            if (settled) return;
            settled = true;
            cleanup();
            error.category = error.category || "spawn";
            reject(error);
        });
        child.on("close", (code) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve({
                code: Number.isInteger(code) ? code : -1,
                stdout,
                stderr,
                timedOut,
                aborted,
            });
        });
    });

export const runProcessOrThrow = async (command, args = [], options = {}) => {
    const result = await runProcess(command, args, options);
    if (result.timedOut) {
        const error = new Error(
            `Process timed out: ${command} ${args.join(" ")}`.trim(),
        );
        error.category = "timeout";
        error.stdout = result.stdout;
        error.stderr = result.stderr;
        throw error;
    }
    if (result.code !== 0) {
        const error = new Error(
            `Process exited with code ${result.code}: ${command} ${args.join(" ")}`.trim(),
        );
        error.category = "exit";
        error.exitCode = result.code;
        error.stdout = result.stdout;
        error.stderr = result.stderr;
        throw error;
    }
    return result;
};
