import globals from "globals";

export default [
    {
        files: ["**/*.js"],
        languageOptions: {
            ecmaVersion: "latest",
            sourceType: "module",
            globals: {
                ...globals.node,
            },
        },
        rules: {
            "no-undef": "error",
            "no-unused-vars": [
                "warn",
                { argsIgnorePattern: "^_", caughtErrors: "none" },
            ],
        },
    },
    {
        ignores: [
            "node_modules/**",
            "tests/.tmp/**",
            "input/**",
            "output/**",
            "log/**",
            ".cache*/**",
        ],
    },
];
