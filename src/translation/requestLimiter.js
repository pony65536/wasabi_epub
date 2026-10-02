/**
 * 共享请求限流器：正文批处理与辅助请求（Director/Glossary/Memory/Critic）共用。
 */
export const createRequestLimiter = (limit = 4) => {
    const max = Math.max(1, Number(limit) || 1);
    let active = 0;
    const queue = [];

    const next = () => {
        if (active >= max || queue.length === 0) return;
        const task = queue.shift();
        active += 1;
        Promise.resolve()
            .then(task.fn)
            .then(
                (value) => {
                    active -= 1;
                    task.resolve(value);
                    next();
                },
                (error) => {
                    active -= 1;
                    task.reject(error);
                    next();
                },
            );
    };

    return {
        run(fn) {
            return new Promise((resolve, reject) => {
                queue.push({ fn, resolve, reject });
                next();
            });
        },
        get active() {
            return active;
        },
        get pending() {
            return queue.length;
        },
    };
};
