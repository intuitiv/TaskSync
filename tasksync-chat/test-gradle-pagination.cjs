// Validates the new logs-pagination + wait readyPattern features live.
const path = require('path');
const { dispatchGradle } = require(path.join(__dirname, '.gradle-test-build', 'gradle', 'gradleEngine.js'));
const PROJECT = '/Users/machs/VSProjects/model-calculation-service-app-logic';
const ENV = { JAVA_HOME: '/Users/machs/Library/Java/JavaVirtualMachines/corretto-17.0.5/Contents/Home' };

(async () => {
    const started = await dispatchGradle({ action: 'start', projectDir: PROJECT, tasks: ['help'], env: ENV }, PROJECT);
    console.log('start:', JSON.stringify(started));
    const buildId = started.buildId;

    // readyPattern: return as soon as Gradle prints its help banner, even though
    // in a server scenario the task would keep running.
    console.log('\n-- wait readyPattern "Welcome to Gradle" --');
    const ready = await dispatchGradle({ action: 'wait', buildId, readyPattern: 'Welcome to Gradle', timeoutMs: 600000 }, PROJECT);
    console.log('ready:', ready.ready, 'state:', ready.state, 'elapsedSec:', ready.elapsedSec);

    // Let it finish so we have a stable buffer to page through.
    const done = await dispatchGradle({ action: 'wait', buildId, timeoutMs: 600000 }, PROJECT);
    console.log('final state:', done.state);

    console.log('\n-- paginate logs forward (maxLines 5) --');
    let cursor = 0, pages = 0, total = null;
    while (pages < 3) {
        const page = await dispatchGradle({ action: 'logs', buildId, fromLine: cursor, maxLines: 5 }, PROJECT);
        total = page.totalLines;
        console.log(`page from=${page.fromLine} to=${page.toLine} total=${page.totalLines} hasMore=${page.hasMore} next=${page.nextFromLine}`);
        console.log(page.log.split('\n').map(l => '   | ' + l).join('\n'));
        if (!page.hasMore) break;
        cursor = page.nextFromLine; pages++;
    }

    console.log('\n-- tail logs (last 3) --');
    const tail = await dispatchGradle({ action: 'logs', buildId, tail: 3 }, PROJECT);
    console.log(`tail from=${tail.fromLine} to=${tail.toLine} total=${tail.totalLines} hasMore=${tail.hasMore}`);
    console.log(tail.log.split('\n').map(l => '   | ' + l).join('\n'));

    process.exit(0);
})();
