/**
 * Browser-bundle config for the client half.
 *
 * Reproduces the artifact contract of the harness's own client preset
 * (`packages/client/tsdown.client.ts`): a CJS closure factory handed to
 * `window.__ModuleLoader__.load`, with every requested module-table row left as
 * a `require()` and everything else inlined.
 *
 * That preset is not reusable here: it imports repository-only modules
 * (`modules/src/client/manifest.ts`, `web/src/platform.ts`,
 * `scripts/client-build-environment.ts`) and `lightningcss`. Only the output
 * contract is reproduced, and only React is treated as a baseline external,
 * which is the subset this package actually imports.
 */
export default {
  name: '@lyzi_nya/dsh-task-center/client',
  entry: { client: 'src/client.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  dts: false,
  sourcemap: true,
  clean: false,
  deps: {
    // React is a baseline module-table row: the bundle must reach it through the
    // injected `require`, never inline a second copy.
    neverBundle: (specifier) => specifier === 'react' || specifier.startsWith('react/'),
    alwaysBundle: (specifier) => !(specifier === 'react' || specifier.startsWith('react/')),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: "@lyzi_nya/dsh-task-center", factory: (require) => {',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  },
}
