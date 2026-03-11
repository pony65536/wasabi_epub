import { GoogleGenerativeAI } from "@google/generative-ai";
import OpenAI from "openai";
import { Logger } from "./logger.js";
import { Config, ProviderConfig } from "./config.js";

export interface AIProvider {
  callAI: (
    userContent: string,
    systemInstruction: string,
    forceJsonMode?: boolean,
  ) => Promise<string>;
  concurrency: number;
  modelName: string;
}

export function createAIProvider(
  providerName: "gemini" | "qwen" | "mimo",
  config: Config,
  logger: Logger,
): AIProvider {
  const providerConfig: ProviderConfig | undefined = config.providers[providerName];

  if (!providerConfig) {
    throw new Error(`Unknown provider: ${providerName}`);
  }

  if (!providerConfig.apiKey) {
    throw new Error(`API key not set for provider: ${providerName}`);
  }

  let callRaw: (
    systemInstruction: string,
    userContent: string,
    forceJson?: boolean,
  ) => Promise<string>;

  if (providerName === "gemini") {
    const genAI = new GoogleGenerativeAI(providerConfig.apiKey);
    const model = genAI.getGenerativeModel({
      model: providerConfig.modelName,
    });

    callRaw = async (systemInstruction: string, userContent: string): Promise<string> => {
      const result = await model.generateContent(
        `${systemInstruction}\n\nUser Input:\n${userContent}`,
      );
      return (await result.response).text().trim();
    };
  } else {
    const client = new OpenAI({
      apiKey: providerConfig.apiKey,
      baseURL: providerConfig.baseURL,
    });

    callRaw = async (
      systemInstruction: string,
      userContent: string,
      forceJson?: boolean,
    ): Promise<string> => {
      const options: Record<string, unknown> = {
        model: providerConfig.modelName,
        messages: [
          { role: "system", content: systemInstruction },
          { role: "user", content: userContent },
        ],
      };

      if (forceJson) {
        options.response_format = { type: "json_object" };
      }

      const completion = await client.chat.completions.create(options);
      return completion.choices[0].message.content.trim();
    };
  }

  const callAI = async (
    userContent: string,
    systemInstruction: string,
    forceJsonMode: boolean = false,
  ): Promise<string> => {
    if (!userContent?.trim()) return "";

    logger.write("REQUEST", `SYSTEM:\n${systemInstruction}\n\nUSER:\n${userContent}`);

    try {
      const responseText = await callRaw(systemInstruction, userContent, forceJsonMode);
      logger.write("RESPONSE", responseText);
      return responseText;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.stack ?? error.message : String(error);
      logger.write("ERROR", `callAI Failed: ${errorMessage}`);
      throw error;
    }
  };

  return {
    callAI,
    concurrency: providerConfig.concurrency,
    modelName: providerConfig.modelName,
  };
}
