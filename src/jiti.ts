import type {
  Jiti,
  TransformOptions,
  JitiOptions,
  Context,
  EvalModuleOptions,
} from "./types";
import { platform } from "node:os";
import { pathToFileURL } from "node:url";
import { join } from "pathe";
import escapeStringRegexp from "escape-string-regexp";
import { normalizeAliases } from "pathe/utils";
import { debug, isDir } from "./utils";
import { resolveJitiOptions } from "./options";
import { jitiResolve } from "./resolve";
import { evalModule } from "./eval";
import { transform } from "./transform";
import { jitiRequire } from "./require";
import { prepareCacheDir } from "./cache";
import { version as jitiVersion } from "../package.json";

const isWindows = platform() === "win32";

export default function createJiti(
  filename: string,
  userOptions: JitiOptions = {},
  parentContext: Pick<
    Context,
    | "parentModule"
    | "parentCache"
    | "nativeImport"
    | "onError"
    | "createRequire"
  >,
  isNested = false,
): Jiti {
  // Resolve options
  const opts = isNested ? userOptions : resolveJitiOptions(userOptions);

  // Normalize aliases (and disable if non given)
  const alias =
    opts.alias && Object.keys(opts.alias).length > 0
      ? normalizeAliases(opts.alias || {})
      : undefined;

  // List of modules to force transform or native
  const nativeModules = ["typescript", "jiti", ...(opts.nativeModules || [])];
  const isNativeRe = new RegExp(
    `node_modules/(${nativeModules
      .map((m) => escapeStringRegexp(m))
      .join("|")})/`,
  );

  const transformModules = [...(opts.transformModules || [])];
  const isTransformRe = new RegExp(
    `node_modules/(${transformModules
      .map((m) => escapeStringRegexp(m))
      .join("|")})/`,
  );

  // If filename is dir, createRequire goes with parent directory, so we need fakepath
  if (!filename) {
    filename = process.cwd();
  }
  if (!isNested && isDir(filename)) {
    filename = join(filename, "index.js");
  }

  const url = pathToFileURL(filename);

  const additionalExts = [...(opts.extensions as string[])].filter(
    (ext) => ext !== ".js",
  );

  const nativeRequire = parentContext.createRequire(
    isWindows
      ? filename.replace(/\//g, "\\") // Import maps does not work with normalized paths!
      : filename,
  );

  // Create shared context
  const ctx: Context = {
    filename,
    url,
    opts,
    alias,
    nativeModules,
    transformModules,
    isNativeRe,
    isTransformRe,
    additionalExts,
    nativeRequire,
    onError: parentContext.onError,
    parentModule: parentContext.parentModule,
    parentCache: parentContext.parentCache,
    nativeImport: parentContext.nativeImport,
    createRequire: parentContext.createRequire,
  };

  // Debug
  if (!isNested) {
    debug(
      ctx,
      "[init]",
      ...[
        ["version:", jitiVersion],
        ["module-cache:", opts.moduleCache],
        ["fs-cache:", opts.fsCache],
        ["interop-defaults:", opts.interopDefault],
      ].flat(),
    );
  }

  // Prepare cache dir
  if (!isNested) {
    prepareCacheDir(ctx);
  }

  // Create jiti instance
  const jiti: Jiti = Object.assign(
    function jiti(id: string) {
      return jitiRequire(ctx, id, false /* no async */);
    },
    {
      cache: opts.moduleCache ? nativeRequire.cache : Object.create(null),
      extensions: nativeRequire.extensions,
      main: nativeRequire.main,
      resolve: Object.assign(
        function resolve(path: string) {
          return jitiResolve(ctx, path, { async: false });
        },
        {
          paths: nativeRequire.resolve.paths,
        },
      ),
      transform(opts: TransformOptions) {
        return transform(ctx, opts);
      },
      evalModule(source: string, options?: EvalModuleOptions) {
        return evalModule(ctx, source, options);
      },
      async import(id: string) {
        return await jitiRequire(ctx, id, true /* async */);
      },
      importResolve(
        id: string,
        parentURL?: string,
        opts?: { conditions?: string[] },
      ) {
        return jitiResolve(ctx, id, { ...opts, async: true, parentURL });
      },
    },
  );

  return jiti;
}
