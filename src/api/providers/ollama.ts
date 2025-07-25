import { Anthropic } from "@anthropic-ai/sdk"
import { Message, Ollama } from "ollama"
import { ApiHandler } from "../"
import { ApiHandlerOptions, ModelInfo, openAiModelInfoSaneDefaults } from "../../shared/api"
import { convertToOllamaMessages } from "../transform/ollama-format"
import { ApiStream } from "../transform/stream"
import { withRetry } from "../retry"

interface OllamaHandlerOptions {
	ollamaBaseUrl?: string
	ollamaApiKey?: string
	ollamaModelId?: string
	ollamaApiOptionsCtxNum?: string
	requestTimeoutMs?: number
}

export class OllamaHandler implements ApiHandler {
	private options: OllamaHandlerOptions
	private client: Ollama | undefined

	constructor(options: OllamaHandlerOptions) {
		this.options = options
	}

	private ensureClient(): Ollama {
		if (!this.client) {
			try {
				const clientOptions: any = {
					host: this.options.ollamaBaseUrl || "http://localhost:11434",
				}

				// Add authentication headers for hosted inference
				if (this.options.ollamaApiKey) {
					clientOptions.headers = {
						Authorization: `Bearer ${this.options.ollamaApiKey}`,
					}
				}

				this.client = new Ollama(clientOptions)
			} catch (error) {
				throw new Error(`Error creating Ollama client: ${error.message}`)
			}
		}
		return this.client
	}

	@withRetry({ retryAllErrors: true })
	async *createMessage(systemPrompt: string, messages: Anthropic.Messages.MessageParam[]): ApiStream {
		const client = this.ensureClient()
		const ollamaMessages: Message[] = [{ role: "system", content: systemPrompt }, ...convertToOllamaMessages(messages)]

		try {
			// Create a promise that rejects after timeout
			const timeoutMs = this.options.requestTimeoutMs || 30000
			const timeoutPromise = new Promise<never>((_, reject) => {
				setTimeout(() => reject(new Error(`Ollama request timed out after ${timeoutMs / 1000} seconds`)), timeoutMs)
			})

			// Create the actual API request promise
			const apiPromise = client.chat({
				model: this.getModel().id,
				messages: ollamaMessages,
				stream: true,
				options: {
					num_ctx: Number(this.options.ollamaApiOptionsCtxNum) || 32768,
				},
			})

			// Race the API request against the timeout
			const stream = (await Promise.race([apiPromise, timeoutPromise])) as Awaited<typeof apiPromise>

			try {
				for await (const chunk of stream) {
					if (typeof chunk.message.content === "string") {
						yield {
							type: "text",
							text: chunk.message.content,
						}
					}

					// Handle token usage if available
					if (chunk.eval_count !== undefined || chunk.prompt_eval_count !== undefined) {
						yield {
							type: "usage",
							inputTokens: chunk.prompt_eval_count || 0,
							outputTokens: chunk.eval_count || 0,
						}
					}
				}
			} catch (streamError: any) {
				console.error("Error processing Ollama stream:", streamError)
				throw new Error(`Ollama stream processing error: ${streamError.message || "Unknown error"}`)
			}
		} catch (error: any) {
			// Check if it's a timeout error
			if (error.message && error.message.includes("timed out")) {
				const timeoutMs = this.options.requestTimeoutMs || 30000
				throw new Error(`Ollama request timed out after ${timeoutMs / 1000} seconds`)
			}

			// Enhance error reporting
			const statusCode = error.status || error.statusCode
			const errorMessage = error.message || "Unknown error"

			console.error(`Ollama API error (${statusCode || "unknown"}): ${errorMessage}`)
			throw error
		}
	}

	getModel(): { id: string; info: ModelInfo } {
		return {
			id: this.options.ollamaModelId || "",
			info: this.options.ollamaApiOptionsCtxNum
				? { ...openAiModelInfoSaneDefaults, contextWindow: Number(this.options.ollamaApiOptionsCtxNum) || 32768 }
				: openAiModelInfoSaneDefaults,
		}
	}
}
