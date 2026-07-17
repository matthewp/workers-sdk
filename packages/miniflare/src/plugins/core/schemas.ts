import {
	BrowserBindingSchema,
	DurableObjectCreatedExportSchema,
	ModuleTypeSchema,
	OutputWorkerSchema,
} from "@cloudflare/config";
import { z } from "zod";
import { ServiceDesignatorSchema } from "./services";
import type { Request, Response } from "../../http";
import type { Miniflare, RemoteProxyConnectionString } from "../../index";
import type { Awaitable } from "../../workers";
import type { DOContainerOptions } from "../do";
import type { UnsafeUniqueKey } from "../shared/constants";
import type * as http from "node:http";

// ---------------------------------------------------------------------------
// Manifest extension
// ---------------------------------------------------------------------------

/**
 * Extends the config manifest's per-module shape with an inline `contents`
 * field. Miniflare never reads from disk — the caller provides contents.
 */
const MiniflareModuleSchema = z.strictObject({
	type: ModuleTypeSchema,
	contents: z.union([z.string(), z.instanceof(Uint8Array)]),
});

const MiniflareManifestSchema = z.strictObject({
	mainModule: z.string(),
	modules: z.record(z.string(), MiniflareModuleSchema),
});

// ---------------------------------------------------------------------------
// Miniflare-only binding extensions
// ---------------------------------------------------------------------------

/**
 * A function-backed "service binding".
 */
const FetcherBindingSchema = z.strictObject({
	type: z.literal("fetcher"),
	handler: z.custom<
		(request: Request, miniflare: Miniflare) => Awaitable<Response>
	>((v) => typeof v === "function"),
});

/**
 * A Node.js http-style service binding handler.
 */
const NodeHandlerBindingSchema = z.strictObject({
	type: z.literal("node-handler"),
	handler: z.custom<
		(
			req: http.IncomingMessage,
			res: http.ServerResponse,
			miniflare: Miniflare
		) => Awaitable<void>
	>((v) => typeof v === "function"),
});

/**
 * Extended browser binding with `headful` (local-only, not in config schema).
 */
const MiniflareBrowserBindingSchema = BrowserBindingSchema.extend({
	headful: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Miniflare-only export extensions
// ---------------------------------------------------------------------------

/**
 * Extends the config's DO "created" export with miniflare-internal fields:
 * - `unsafeUniqueKey` — custom unique key for DO namespace identity
 * - `unsafePreventEviction` — prevents the DO from being evicted
 * - `container` — container config for container-attached DOs
 */
const MiniflareDurableObjectExportSchema =
	DurableObjectCreatedExportSchema.extend({
		unsafeUniqueKey: z.custom<UnsafeUniqueKey>().optional(),
		unsafePreventEviction: z.boolean().optional(),
		container: z.custom<DOContainerOptions>().optional(),
	});

/**
 * Validates export entries. Miniflare-extended DO exports (with
 * unsafeUniqueKey etc.) are checked first; everything else passes through.
 */
const MiniflareExportSchema = z.unknown().transform((value, ctx) => {
	if (typeof value !== "object" || value === null || !("type" in value)) {
		ctx.addIssue({
			code: "custom",
			message: "Export must be an object with a 'type' field",
		});
		return z.NEVER;
	}
	const v = value as { type: unknown; state?: unknown };
	if (
		v.type === "durable-object" &&
		(v.state === undefined || v.state === "created")
	) {
		const result = MiniflareDurableObjectExportSchema.safeParse(value);
		if (!result.success) {
			ctx.issues.push(...(result.error.issues as unknown as typeof ctx.issues));
			return z.NEVER;
		}
		return result.data;
	}
	return value;
});

// ---------------------------------------------------------------------------
// Worker config schema (extends OutputWorkerSchema)
// ---------------------------------------------------------------------------

/**
 * The env record accepts all standard config binding types plus
 * miniflare-only types (`fetcher`, `node-handler`) and extensions to
 * standard types (`browser` with `headful`). Standard bindings are
 * pre-validated upstream by the config schema in wrangler/vite, so we
 * don't re-validate them here — they pass through.
 *
 * Miniflare-specific types and extensions are runtime-checked by type.
 */
const MINIFLARE_BINDING_SCHEMAS: Record<string, z.ZodType<unknown, unknown>> = {
	fetcher: FetcherBindingSchema,
	"node-handler": NodeHandlerBindingSchema,
	browser: MiniflareBrowserBindingSchema,
};

const MiniflareBindingSchema = z.unknown().transform((value, ctx) => {
	if (typeof value !== "object" || value === null || !("type" in value)) {
		ctx.addIssue({
			code: "custom",
			message: "Binding must be an object with a 'type' field",
		});
		return z.NEVER;
	}
	const { type } = value as { type: unknown };
	const schema = MINIFLARE_BINDING_SCHEMAS[type as string];
	if (schema) {
		const result = schema.safeParse(value);
		if (!result.success) {
			ctx.issues.push(...(result.error.issues as unknown as typeof ctx.issues));
			return z.NEVER;
		}
		return result.data;
	}
	// Standard config bindings pass through without re-validation — the
	// config schema validates these upstream.
	return value;
});

/**
 * OutputWorkerSchema with the manifest replaced by the miniflare-extended
 * version (which includes `contents` per module) and env extended with
 * miniflare-only binding types.
 *
 * Fields miniflare doesn't care about (e.g. deploy-only fields like
 * `placement`, `logpush`) pass through harmlessly — they're validated by
 * the config schema upstream but ignored at runtime.
 */
const MiniflareWorkerConfigSchema = OutputWorkerSchema.omit({
	manifest: true,
	env: true,
	exports: true,
}).extend({
	manifest: MiniflareManifestSchema.optional(),
	env: z.record(z.string(), MiniflareBindingSchema).optional(),
	exports: z.record(z.string(), MiniflareExportSchema).optional(),
});

export type MiniflareWorkerConfig = z.input<typeof MiniflareWorkerConfigSchema>;

// ---------------------------------------------------------------------------
// Dev config
// ---------------------------------------------------------------------------

const UnsafeDirectSocketSchema = z.object({
	host: z.string().optional(),
	port: z.number().optional(),
	serviceName: z.string().optional(),
	entrypoint: z.string().optional(),
	proxy: z.boolean().optional(),
});

const DevConfigSchema = z.strictObject({
	disableCache: z.boolean().optional(),
	outboundService: ServiceDesignatorSchema.optional(),
	remoteProxyConnectionString: z
		.custom<RemoteProxyConnectionString>()
		.optional(),
	unsafeInspectorProxy: z.boolean().optional(),
	unsafeDirectSockets: z.array(UnsafeDirectSocketSchema).optional(),
	unsafeOverrideFetchWorker: z.string().optional(),
	unsafeEvalBinding: z.string().optional(),
	useModuleFallbackService: z.boolean().optional(),
	hasAssetsAndIsVitest: z.boolean().optional(),
});

export type DevConfig = z.input<typeof DevConfigSchema>;

// ---------------------------------------------------------------------------
// Legacy config (service-worker format, Workers Sites)
// ---------------------------------------------------------------------------

const LegacyConfigSchema = z.strictObject({
	wasmBindings: z
		.record(z.string(), z.union([z.string(), z.instanceof(Uint8Array)]))
		.optional(),
	textBlobBindings: z.record(z.string(), z.string()).optional(),
	dataBlobBindings: z
		.record(z.string(), z.union([z.string(), z.instanceof(Uint8Array)]))
		.optional(),
	sitePath: z.string().optional(),
	siteInclude: z.array(z.string()).optional(),
	siteExclude: z.array(z.string()).optional(),
});

export type LegacyConfig = z.input<typeof LegacyConfigSchema>;

// ---------------------------------------------------------------------------
// Per-worker options
// ---------------------------------------------------------------------------

export const WorkerOptionsSchema = z.strictObject({
	config: MiniflareWorkerConfigSchema,
	legacy: LegacyConfigSchema.optional(),
	dev: DevConfigSchema.optional(),
});

export type WorkerOptions = z.input<typeof WorkerOptionsSchema>;

// ---------------------------------------------------------------------------
// Shared (instance-wide) options
// ---------------------------------------------------------------------------

export const SharedOptionsSchema = z.object({
	// Server
	host: z.string().optional(),
	port: z.number().optional(),
	https: z.boolean().optional(),
	httpsKey: z.string().optional(),
	httpsCert: z.string().optional(),

	// Inspector
	inspectorPort: z.number().optional(),
	inspectorHost: z.string().optional(),

	// Runtime
	verbose: z.boolean().optional(),
	log: z.custom<import("../../shared").Log>().optional(),
	handleStructuredLogs: z
		.custom<(log: import("../../index").WorkerdStructuredLog) => void>()
		.optional(),
	upstream: z.string().optional(),
	cf: z
		.union([z.boolean(), z.string(), z.record(z.string(), z.any())])
		.optional(),

	// Logging
	logRequests: z.boolean().default(true),
	stripDisablePrettyError: z.boolean().default(true),

	// Persistence
	persistRoot: z.string().optional(),

	// Container engine (moved from worker-level to instance-level)
	containerEngine: z
		.union([
			z.string(),
			z.object({
				localDocker: z.object({
					socketPath: z.string(),
				}),
			}),
		])
		.optional(),

	// Telemetry
	telemetry: z
		.object({
			enabled: z.boolean().default(false),
			deviceId: z.string().optional(),
		})
		.default({ enabled: false }),

	// Internal
	publicUrl: z.string().url().optional(),
	devRegistryPath: z.string().optional(),
	handleDevRegistryUpdate: z
		.custom<
			(
				registry: import("../../shared/dev-registry-types").WorkerRegistry
			) => void
		>()
		.optional(),
	proxySharedSecret: z.string().optional(),
	moduleFallbackService: z
		.custom<(request: Request, miniflare: Miniflare) => Awaitable<Response>>()
		.optional(),
	unsafeStickyBlobs: z.boolean().optional(),
	triggerHandlers: z.boolean().optional(),
	runtimeEnv: z.record(z.string(), z.string()).optional(),
	enableLocalExplorer: z.boolean().optional(),
});

export type SharedOptions = z.input<typeof SharedOptionsSchema>;

// ---------------------------------------------------------------------------
// Top-level Miniflare options
// ---------------------------------------------------------------------------

export const MiniflareOptionsSchema = SharedOptionsSchema.extend({
	workers: z.array(WorkerOptionsSchema),
});

export type MiniflareOptions = z.input<typeof MiniflareOptionsSchema>;
