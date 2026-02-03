const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');

async function main() {
    const ctx = await esbuild.context({
        entryPoints: ['src/extension.ts'],
        bundle: true,
        outfile: 'dist/extension.js',
        external: [
            'vscode',
            // Socket.io and its dependencies must be external
            // They don't bundle correctly with esbuild
            'socket.io',
            'engine.io',
            'ws',
            'bufferutil',
            'utf-8-validate'
        ],
        format: 'cjs',
        platform: 'node',
        target: 'node18',
        sourcemap: true,
        minify: !watch,
        // Handle ESM packages with .js extensions
        mainFields: ['module', 'main'],
        conditions: ['import', 'node'],
        resolveExtensions: ['.ts', '.js', '.mjs'],
    });

    if (watch) {
        await ctx.watch();
        console.log('Watching for changes...');
    } else {
        await ctx.rebuild();
        await ctx.dispose();
        console.log('Build complete');
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
