import crypto from "node:crypto";
import { access, lstat, mkdtemp } from "node:fs/promises";
import { cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as esbuild from "esbuild";
import { toUrlPath } from "./paths";
import {
	generateConfigFromFileTree,
	writeRoutesModule,
	convertRoutesToRoutesJSONSpec,
} from "./routing";
import type { UrlPath } from "./paths";
import type { Config, RouteConfig, RoutesJSONSpec } from "./routing";

/**
 * Options for compiling a Pages Functions directory into a Worker.
 */
export interface BuildPagesFunctionsOptions {
	/** Path to the functions directory containing route handler files. */
	functionsDirectory: string;

	/** Directory where the compiled Worker and its modules will be written. */
	outputDirectory: string;

	/**
	 * Directory to output static assets referenced via `assets:` imports.
	 * Defaults to `outputDirectory` if not specified.
	 */
	assetsOutputDirectory?: string;

	/**
	 * The service binding name to fall back to when no route matches.
	 * Defaults to `"ASSETS"`.
	 */
	fallbackService?: string;

	/** Whether to minify the output. Defaults to `false`. */
	minify?: boolean;

	/** Whether to generate source maps. Defaults to `false`. */
	sourcemap?: boolean;

	/** Module specifiers to exclude from the bundle. */
	external?: string[];

	/**
	 * Optional description to include in the generated `_routes.json`.
	 * If not provided, no description is included.
	 */
	routesDescription?: string;

	/** Whether to output esbuild metafile. Defaults to `false`. */
	metafile?: boolean;
}

/**
 * A collected non-JS module (WASM, text, or binary data) that should be
 * uploaded alongside the Worker entrypoint.
 */
export interface CollectedModule {
	/** The module name as referenced in the Worker bundle. */
	name: string;

	/** The module file content. */
	content: Uint8Array;

	/** The module type for the Workers upload API. */
	type: "compiled-wasm" | "text" | "buffer";
}

/**
 * The result of compiling a Pages Functions directory.
 */
export interface BuildPagesFunctionsResult {
	/** Absolute path to the compiled Worker entrypoint. */
	entryPointPath: string;

	/** The bundle format — always `"esm"` for Pages Functions. */
	bundleType: "esm";

	/** Non-JS modules (WASM, text, binary) collected during bundling. */
	modules: CollectedModule[];

	/** esbuild dependency graph for the bundle. */
	dependencies: esbuild.Metafile["outputs"][string]["inputs"];

	/** Path to the source map file, if source maps were enabled. */
	sourceMapPath?: string;

	/** The generated `_routes.json` routing spec. */
	routesJSON: RoutesJSONSpec;

	/** The filepath routing configuration (routes + baseURL). */
	filepathRoutingConfig: {
		routes: RouteConfig[];
		baseURL: UrlPath;
	};

	/** The esbuild metafile, if `metafile` was enabled. */
	metafile?: esbuild.Metafile;
}

/**
 * Compile a Pages Functions directory into a deployable Cloudflare Worker.
 *
 * This function:
 * 1. Scans the functions directory for route handler exports
 * 2. Generates a routes module mapping URL patterns to handlers
 * 3. Bundles the Pages Worker runtime template with the routes
 * 4. Collects non-JS modules (WASM, text, binary)
 * 5. Writes the output to the specified directory
 *
 * @param options - Build configuration
 * @returns The build result including entrypoint path, modules, and routing metadata
 * @throws When no routes are found in the functions directory
 * @throws When the functions directory does not exist
 */
export async function buildPagesFunctions(
	options: BuildPagesFunctionsOptions
): Promise<BuildPagesFunctionsResult> {
	const {
		functionsDirectory,
		outputDirectory,
		assetsOutputDirectory,
		fallbackService = "ASSETS",
		minify = false,
		sourcemap = false,
		external,
		routesDescription,
		metafile = false,
	} = options;

	const absoluteFunctionsDirectory = resolve(functionsDirectory);
	const absoluteOutputDirectory = resolve(outputDirectory);

	const baseURL = toUrlPath("/");

	// Step 1: Discover routes from the filesystem
	const config: Config = await generateConfigFromFileTree({
		baseDir: absoluteFunctionsDirectory,
		baseURL,
	});

	if (!config.routes || config.routes.length === 0) {
		throw new PagesFunctionsNoRoutesError(
			`Failed to find any routes while compiling Functions in: ${functionsDirectory}`
		);
	}

	// Step 2: Generate the _routes.json spec
	const routesJSON = convertRoutesToRoutesJSONSpec(
		config.routes,
		routesDescription
	);

	// Step 3: Write a temporary routes module
	const tmpDir = await mkdtemp(join(tmpdir(), "pages-functions-"));
	const routesModulePath = join(tmpDir, "functionsRoutes.mjs");

	await writeRoutesModule({
		config,
		srcDir: absoluteFunctionsDirectory,
		outfile: routesModulePath,
	});

	// Step 4: Resolve the template path.
	// The template is a raw .ts file that esbuild compiles at runtime.
	// It is shipped in src/templates/ relative to the package root.
	// When running from source (src/build.ts): import.meta.dirname is src/ -> ../src/templates/
	// When running from dist (dist/index.mjs): import.meta.dirname is dist/ -> ../src/templates/
	const templatePath = resolve(
		import.meta.dirname,
		"..",
		"src",
		"templates",
		"pages-template-worker.ts"
	);

	// Step 5: Collect non-JS modules and build
	const collectedModules: CollectedModule[] = [];
	const outfile = join(absoluteOutputDirectory, "index.js");

	const moduleCollectorPlugin: esbuild.Plugin = {
		name: "pages-functions-module-collector",
		setup(build) {
			// WASM modules
			build.onResolve({ filter: /\.wasm(\?module)?$/ }, (args) => ({
				path: resolve(args.resolveDir, args.path.replace(/\?module$/, "")),
				namespace: "pages-functions-wasm",
			}));
			build.onLoad(
				{ filter: /.*/, namespace: "pages-functions-wasm" },
				async (args) => {
					const { readFile } = await import("node:fs/promises");
					const content = await readFile(args.path);
					const hash = crypto
						.createHash("sha1")
						.update(content)
						.digest("hex")
						.slice(0, 8);
					const basename = args.path.split("/").pop();
					const moduleName = `${hash}-${basename}`;
					collectedModules.push({
						name: moduleName,
						content: new Uint8Array(content),
						type: "compiled-wasm",
					});
					return {
						contents: `export default ${moduleName};`,
						loader: "js",
					};
				}
			);

			// Text modules
			build.onResolve({ filter: /\.(txt|html|sql)$/ }, (args) => ({
				path: resolve(args.resolveDir, args.path),
				namespace: "pages-functions-text",
			}));
			build.onLoad(
				{ filter: /.*/, namespace: "pages-functions-text" },
				async (args) => {
					const { readFile } = await import("node:fs/promises");
					const content = await readFile(args.path);
					const hash = crypto
						.createHash("sha1")
						.update(content)
						.digest("hex")
						.slice(0, 8);
					const basename = args.path.split("/").pop();
					const moduleName = `${hash}-${basename}`;
					collectedModules.push({
						name: moduleName,
						content: new Uint8Array(content),
						type: "text",
					});
					return {
						contents: `export default ${moduleName};`,
						loader: "js",
					};
				}
			);

			// Binary/data modules
			build.onResolve({ filter: /\.bin$/ }, (args) => ({
				path: resolve(args.resolveDir, args.path),
				namespace: "pages-functions-data",
			}));
			build.onLoad(
				{ filter: /.*/, namespace: "pages-functions-data" },
				async (args) => {
					const { readFile } = await import("node:fs/promises");
					const content = await readFile(args.path);
					const hash = crypto
						.createHash("sha1")
						.update(content)
						.digest("hex")
						.slice(0, 8);
					const basename = args.path.split("/").pop();
					const moduleName = `${hash}-${basename}`;
					collectedModules.push({
						name: moduleName,
						content: new Uint8Array(content),
						type: "buffer",
					});
					return {
						contents: `export default ${moduleName};`,
						loader: "js",
					};
				}
			);
		},
	};

	// Step 6: Assets plugin for `assets:` imports
	const assetsPlugin: esbuild.Plugin = {
		name: "pages-functions-assets",
		setup(pluginBuild) {
			const identifiers = new Map<string, string>();

			pluginBuild.onResolve({ filter: /^assets:/ }, async (args) => {
				const directory = resolve(
					args.resolveDir,
					args.path.slice("assets:".length)
				);

				const exists = await access(directory)
					.then(() => true)
					.catch(() => false);

				const isDirectory = exists && (await lstat(directory)).isDirectory();

				if (!isDirectory) {
					return {
						errors: [
							{
								text: `'${directory}' does not exist or is not a directory.`,
							},
						],
					};
				}

				identifiers.set(directory, crypto.randomUUID());
				return { path: directory, namespace: "assets" };
			});

			pluginBuild.onLoad(
				{ filter: /.*/, namespace: "assets" },
				async (args) => {
					const identifier = identifiers.get(args.path);
					const targetDir = assetsOutputDirectory || absoluteOutputDirectory;

					const staticAssetsOutputDirectory = join(
						targetDir,
						"cdn-cgi",
						"pages-plugins",
						identifier as string
					);
					await cp(args.path, staticAssetsOutputDirectory, {
						force: true,
						recursive: true,
					});

					return {
						contents: `export const onRequest = ({ request, env, functionPath }) => {
							const url = new URL(request.url);
							const relativePathname = \`/\${url.pathname.replace(functionPath, "") || ""}\`.replace(/^\\/\\//, '/');
							url.pathname = '/cdn-cgi/pages-plugins/${identifier}' + relativePathname;
							request = new Request(url.toString(), request);
							return env.ASSETS.fetch(request);
						}`,
					};
				}
			);
		},
	};

	// Step 7: Run esbuild
	const result = await esbuild.build({
		entryPoints: [templatePath],
		outfile,
		bundle: true,
		format: "esm",
		// v8 supports es2024 features as of 11.9
		target: "es2024",
		supported: { "import-source": true },
		loader: { ".js": "jsx", ".mjs": "jsx", ".cjs": "jsx" },
		conditions: ["workerd", "worker", "browser"],
		inject: [routesModulePath],
		define: {
			__FALLBACK_SERVICE__: JSON.stringify(fallbackService),
		},
		minify,
		keepNames: true,
		sourcemap,
		metafile: true,
		external,
		plugins: [moduleCollectorPlugin, assetsPlugin],
	});

	// Step 8: Extract dependency and entry info from metafile
	const metaOutputs = result.metafile?.outputs ?? {};
	const entryOutput = Object.values(metaOutputs).find(
		(output) => output.entryPoint !== undefined
	);
	const dependencies = entryOutput?.inputs ?? {};

	let sourceMapPath: string | undefined;
	if (sourcemap) {
		const mapFile = `${outfile}.map`;
		try {
			await access(mapFile);
			sourceMapPath = mapFile;
		} catch {
			// source map may be inline
		}
	}

	return {
		entryPointPath: outfile,
		bundleType: "esm",
		modules: collectedModules,
		dependencies,
		sourceMapPath,
		routesJSON,
		filepathRoutingConfig: {
			routes: config.routes,
			baseURL,
		},
		metafile: metafile ? result.metafile : undefined,
	};
}

/**
 * Error thrown when no routes are found in the functions directory.
 */
export class PagesFunctionsNoRoutesError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PagesFunctionsNoRoutesError";
	}
}
