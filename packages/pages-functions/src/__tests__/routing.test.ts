import { describe, it } from "vitest";
import {
	consolidateRoutes,
	shortenRoute,
	convertRoutesToGlobPatterns,
	convertRoutesToRoutesJSONSpec,
	isRoutesJSONSpec,
	validateRoutes,
	isValidIdentifier,
	normalizeIdentifier,
	MAX_FUNCTIONS_ROUTES_RULES,
	MAX_FUNCTIONS_ROUTES_RULE_LENGTH,
	ROUTES_SPEC_VERSION,
	toUrlPath,
} from "../index";

describe("route-consolidation", () => {
	it("should consolidate redundant routes", ({ expect }) => {
		expect(consolidateRoutes(["/api/foo", "/api/*"])).toEqual(["/api/*"]);
		expect(
			consolidateRoutes([
				"/api/foo",
				"/api/foo/*",
				"/api/bar/*",
				"/api/*",
				"/foo",
				"/foo/bar",
				"/bar/*",
				"/bar/baz/*",
				"/bar/baz/hello",
			])
		).toEqual(["/api/*", "/foo", "/foo/bar", "/bar/*"]);
	});

	it("should truncate long single-level path into catch-all", ({ expect }) => {
		expect(
			consolidateRoutes([
				"/" + "a".repeat(MAX_FUNCTIONS_ROUTES_RULE_LENGTH * 2),
				"/foo",
				"/bar/*",
				"/baz/bagel/coffee",
			])
		).toEqual(["/*"]);
	});
});

describe("shortenRoute", () => {
	it("should allow max length path", ({ expect }) => {
		const route = "/" + "a".repeat(MAX_FUNCTIONS_ROUTES_RULE_LENGTH - 1);
		expect(route.length).toEqual(MAX_FUNCTIONS_ROUTES_RULE_LENGTH);
		expect(shortenRoute(route)).toEqual(route);
	});

	it("should truncate long specific path to shorter wildcard path", ({
		expect,
	}) => {
		const short = shortenRoute(
			"/" +
				"a".repeat(MAX_FUNCTIONS_ROUTES_RULE_LENGTH * 0.6) +
				"/" +
				"b".repeat(MAX_FUNCTIONS_ROUTES_RULE_LENGTH * 0.6)
		);
		expect(short).toEqual(
			"/" + "a".repeat(MAX_FUNCTIONS_ROUTES_RULE_LENGTH * 0.6) + "/*"
		);
		expect(short.length).toBeLessThanOrEqual(MAX_FUNCTIONS_ROUTES_RULE_LENGTH);
	});

	it("should truncate long single-level specific path to catch-all path", ({
		expect,
	}) => {
		expect(
			shortenRoute("/" + "a".repeat(MAX_FUNCTIONS_ROUTES_RULE_LENGTH * 2))
		).toEqual("/*");
	});
});

describe("route-glob-patterns", () => {
	it("should pass through routes with no wildcards", ({ expect }) => {
		expect(
			convertRoutesToGlobPatterns([{ routePath: toUrlPath("/api/foo") }])
		).toEqual(["/api/foo"]);
	});

	it("should escalate a single param route to a wildcard", ({ expect }) => {
		expect(
			convertRoutesToGlobPatterns([{ routePath: toUrlPath("/api/:foo") }])
		).toEqual(["/api/*"]);
	});

	it("should add glob to middleware mountings", ({ expect }) => {
		expect(
			convertRoutesToGlobPatterns([
				{
					routePath: toUrlPath("/api"),
					middleware: ["some-middleware:onRequest"],
				},
			])
		).toEqual(["/api/*"]);
	});
});

describe("convertRoutesToRoutesJSONSpec", () => {
	it("should produce a valid RoutesJSONSpec", ({ expect }) => {
		const result = convertRoutesToRoutesJSONSpec(
			[{ routePath: toUrlPath("/api/foo") }],
			"test"
		);
		expect(result.version).toEqual(ROUTES_SPEC_VERSION);
		expect(result.description).toEqual("test");
		expect(result.include).toContain("/api/foo");
		expect(result.exclude).toEqual([]);
	});

	it("should truncate to catch-all if over MAX_FUNCTIONS_ROUTES_RULES", ({
		expect,
	}) => {
		const routes = [];
		for (let i = 0; i < MAX_FUNCTIONS_ROUTES_RULES + 10; i++) {
			routes.push({ routePath: toUrlPath(`/route-${i}`) });
		}
		const result = convertRoutesToRoutesJSONSpec(routes);
		expect(result.include).toEqual(["/*"]);
	});
});

describe("isRoutesJSONSpec", () => {
	it("should return true for valid spec", ({ expect }) => {
		expect(
			isRoutesJSONSpec({
				version: ROUTES_SPEC_VERSION,
				include: ["/api/*"],
				exclude: [],
			})
		).toBe(true);
	});

	it("should return false for invalid spec", ({ expect }) => {
		expect(isRoutesJSONSpec({ include: [], exclude: [] })).toBe(false);
		expect(isRoutesJSONSpec({ version: 999, include: [], exclude: [] })).toBe(
			false
		);
	});
});

describe("validateRoutes", () => {
	it("should not throw for valid routes", ({ expect }) => {
		expect(() =>
			validateRoutes(
				{
					version: ROUTES_SPEC_VERSION,
					include: ["/api/*"],
					exclude: [],
				},
				"_routes.json"
			)
		).not.toThrow();
	});

	it("should throw for missing include rules", ({ expect }) => {
		expect(() =>
			validateRoutes(
				{
					version: ROUTES_SPEC_VERSION,
					include: [],
					exclude: [],
				},
				"_routes.json"
			)
		).toThrow();
	});

	it("should throw for overlapping rules", ({ expect }) => {
		expect(() =>
			validateRoutes(
				{
					version: ROUTES_SPEC_VERSION,
					include: ["/api/*", "/api/foo"],
					exclude: [],
				},
				"_routes.json"
			)
		).toThrow();
	});
});

describe("identifiers", () => {
	it("should validate identifiers correctly", ({ expect }) => {
		expect(isValidIdentifier("foo")).toBe(true);
		expect(isValidIdentifier("_bar")).toBe(true);
		expect(isValidIdentifier("$baz")).toBe(true);
		expect(isValidIdentifier("class")).toBe(false);
		expect(isValidIdentifier("123")).toBe(false);
	});

	it("should normalize identifiers", ({ expect }) => {
		expect(normalizeIdentifier("hello-world")).toBe("hello_world");
		expect(normalizeIdentifier("123abc")).toBe("_23abc");
	});
});

describe("toUrlPath", () => {
	it("should convert backslashes to forward slashes", ({ expect }) => {
		expect(toUrlPath("foo\\bar")).toBe("foo/bar");
		expect(toUrlPath("foo/bar")).toBe("foo/bar");
	});
});
