import net from 'node:net';
import { z } from 'zod';
import { getComponent, systemManager } from '../scrypted';

// npm package name of this plugin. Used to refuse get_storage / set_storage against any
// device owned by us — that storage holds the OAuth signing key and DCR registrations,
// and exposing it would let any authorized caller forge tokens or hijack registered
// clients. There's no legitimate reason for an MCP tool call to read or write the MCP
// plugin's own storage, so the block is a hard reject rather than a redaction.
const SELF_PLUGIN_ID = 'scrypted-mcp';

function refuseIfOwnPlugin(deviceId: string): void {
    const dev = systemManager.getDeviceById(deviceId) as { pluginId?: string } | undefined;
    if (dev?.pluginId === SELF_PLUGIN_ID) {
        throw new Error(
            "refusing to read/write the scrypted-mcp plugin's own storage; it holds the OAuth signing key and client registrations",
        );
    }
}

interface PluginComponent {
    getPluginInfo(pluginId: string): Promise<any>;
    reload(pluginId: string): Promise<void>;
    kill(pluginId: string): Promise<void>;
    installNpm(pkg: string, version?: string): Promise<string>;
    updatePlugins(): Promise<any>;
    renameDeviceId(id: string, newId: string): Promise<void>;
    setMixins(id: string, mixins: string[]): Promise<void>;
    npmInfo(endpoint: string): Promise<any>;
    getStorage(id: string): Promise<Record<string, string>>;
    setStorage(id: string, storage: Record<string, string>): Promise<void>;
    getIdForNativeId(pluginId: string, nativeId: string | undefined): Promise<string | undefined>;
    disconnectClients(pluginId: string): Promise<void>;
    clearConsole(id: string): Promise<void>;
    // Added in the server after 0.147.0; older servers only expose the console via
    // getRemoteServicePort, see readConsoleViaPort.
    readConsole(id: string): Promise<string>;
    getRemoteServicePort(pluginId: string, name: string): Promise<[number, string | undefined]>;
}

export const listPluginsInput = z.object({});

export async function listPlugins() {
    const state = systemManager.getSystemState();
    // Every device carries a `pluginId`, so filtering on that alone lists cameras, sirens and
    // users too. A plugin's own root device is the one with no nativeId. We surface both ids
    // and the human-readable name so the LLM can pick the right one for follow-ups.
    const plugins: Array<{ id: string; pluginId: string; name: string; type: string }> = [];
    for (const id of Object.keys(state)) {
        const dev = state[id];
        const pluginId = dev?.pluginId?.value;
        const name = dev?.name?.value;
        const type = dev?.type?.value;
        const nativeId = dev?.nativeId?.value;
        if (pluginId && name && (nativeId === undefined || nativeId === null))
            plugins.push({ id, pluginId, name, type: type ?? '' });
    }
    plugins.sort((a, b) => a.name.localeCompare(b.name));
    return { count: plugins.length, plugins };
}

export const getPluginInfoInput = z.object({
    pluginId: z.string().describe('npm package id — the `pluginId` field from list_plugins, e.g. "scrypted-kasa".'),
});

export async function getPluginInfo(args: z.infer<typeof getPluginInfoInput>) {
    const plugins = await getComponent<PluginComponent>('plugins');
    const info = await plugins.getPluginInfo(args.pluginId);
    return info ?? { error: 'plugin not found' };
}

export const reloadPluginInput = z.object({
    pluginId: z
        .string()
        .describe('npm package id to reload — the `pluginId` field from list_plugins, e.g. "scrypted-kasa".'),
});

export async function reloadPlugin(args: z.infer<typeof reloadPluginInput>) {
    const plugins = await getComponent<PluginComponent>('plugins');
    await plugins.reload(args.pluginId);
    return { reloaded: args.pluginId };
}

export const killPluginInput = z.object({
    pluginId: z
        .string()
        .describe('npm package id to kill — the `pluginId` field from list_plugins, e.g. "scrypted-kasa".'),
});

export async function killPlugin(args: z.infer<typeof killPluginInput>) {
    const plugins = await getComponent<PluginComponent>('plugins');
    await plugins.kill(args.pluginId);
    return { killed: args.pluginId };
}

export const installPluginInput = z.object({
    npmPackage: z.string().describe('npm package id, e.g. "scrypted-kasa".'),
    version: z.string().optional().describe('Version specifier; omit for latest.'),
});

export async function installPlugin(args: z.infer<typeof installPluginInput>) {
    const plugins = await getComponent<PluginComponent>('plugins');
    const id = await plugins.installNpm(args.npmPackage, args.version);
    return { pluginDeviceId: id };
}

export const updatePluginsInput = z.object({});

export async function updatePlugins() {
    const plugins = await getComponent<PluginComponent>('plugins');
    // updatePlugins resolves void on the Scrypted side, so return a confirmation object —
    // a bare undefined would JSON.stringify to undefined and fail the MCP content schema.
    const result = await plugins.updatePlugins();
    return result ?? { updated: true };
}

export const renameDeviceIdInput = z.object({
    id: z.string().describe('Current Scrypted device id (the `id` field from list_devices or list_plugins).'),
    newId: z.string().describe('New device id. Must not collide with an existing device.'),
});

export async function renameDeviceId(args: z.infer<typeof renameDeviceIdInput>) {
    // Server-side this kills the owning plugin host, rewrites references in the datastore,
    // then lets it auto-restart. Expect a brief offline window for the plugin.
    const plugins = await getComponent<PluginComponent>('plugins');
    await plugins.renameDeviceId(args.id, args.newId);
    return { renamed: { from: args.id, to: args.newId } };
}

export const setMixinsInput = z.object({
    id: z
        .string()
        .describe('Scrypted device id whose mixins to replace (the `id` field from list_devices or list_plugins).'),
    mixins: z
        .array(z.string())
        .describe(
            'Full replacement list of mixin device ids. REPLACES the existing list — to add or remove a single mixin, first call get_device on `id` to read the current `mixins` array, then pass the modified array here.',
        ),
});

export async function setMixins(args: z.infer<typeof setMixinsInput>) {
    const plugins = await getComponent<PluginComponent>('plugins');
    await plugins.setMixins(args.id, args.mixins);
    return { id: args.id, mixins: args.mixins };
}

export const npmInfoInput = z.object({
    endpoint: z
        .string()
        .describe(
            'Path appended to https://registry.npmjs.org/. Pass a package name like "scrypted-kasa" for full package metadata (versions, dist-tags, deprecation), or "-/v1/search?text=keywords:scrypted-plugin" to discover available Scrypted plugins via npm search.',
        ),
});

export async function npmInfo(args: z.infer<typeof npmInfoInput>) {
    // Server-side this is a passthrough to https://registry.npmjs.org/${endpoint}, so we
    // don't need to filter or validate — npm responds with whatever the endpoint expects.
    const plugins = await getComponent<PluginComponent>('plugins');
    return plugins.npmInfo(args.endpoint);
}

export const getStorageInput = z.object({
    id: z
        .string()
        .describe(
            'Scrypted device id whose persistent storage to read (the `id` field from list_devices or list_plugins).',
        ),
});

export async function getStorage(args: z.infer<typeof getStorageInput>) {
    refuseIfOwnPlugin(args.id);
    const plugins = await getComponent<PluginComponent>('plugins');
    const storage = await plugins.getStorage(args.id);
    return { id: args.id, storage: storage ?? {} };
}

export const setStorageInput = z.object({
    id: z
        .string()
        .describe(
            'Scrypted device id whose persistent storage to overwrite (the `id` field from list_devices or list_plugins).',
        ),
    storage: z
        .record(z.string(), z.string())
        .describe(
            "Replacement storage map (keys and values are strings). REPLACES the device's entire storage — read get_storage first if you only want to change one key.",
        ),
});

export async function setStorage(args: z.infer<typeof setStorageInput>) {
    refuseIfOwnPlugin(args.id);
    const plugins = await getComponent<PluginComponent>('plugins');
    await plugins.setStorage(args.id, args.storage);
    return { id: args.id, storage: args.storage };
}

export const getIdForNativeIdInput = z.object({
    pluginId: z
        .string()
        .describe(
            'npm package id of the owning plugin — the `pluginId` field from list_plugins, e.g. "scrypted-kasa".',
        ),
    nativeId: z
        .string()
        .optional()
        .describe(
            "The plugin's internal native id for the device (often visible in logs). Omit for the plugin's root device.",
        ),
});

export async function getIdForNativeId(args: z.infer<typeof getIdForNativeIdInput>) {
    const plugins = await getComponent<PluginComponent>('plugins');
    const id = await plugins.getIdForNativeId(args.pluginId, args.nativeId);
    return { id: id ?? null };
}

export const disconnectClientsInput = z.object({
    pluginId: z
        .string()
        .describe('npm package id whose websocket clients to disconnect — the `pluginId` field from list_plugins.'),
});

export async function disconnectClients(args: z.infer<typeof disconnectClientsInput>) {
    const plugins = await getComponent<PluginComponent>('plugins');
    await plugins.disconnectClients(args.pluginId);
    return { disconnected: args.pluginId };
}

export const clearConsoleInput = z.object({
    id: z
        .string()
        .describe(
            'Scrypted device id whose console buffer to clear (the `id` field from list_devices or list_plugins).',
        ),
});

export async function clearConsole(args: z.infer<typeof clearConsoleInput>) {
    const plugins = await getComponent<PluginComponent>('plugins');
    await plugins.clearConsole(args.id);
    return { cleared: args.id };
}

export const readConsoleInput = z.object({
    id: z
        .string()
        .describe(
            "Scrypted device id whose console buffer to read (the `id` field from list_devices or list_plugins). A plugin id reads the plugin-wide console; a device id reads that device's console.",
        ),
    tail: z
        .number()
        .int()
        .min(1)
        .max(5000)
        .optional()
        .describe('Return only the last N lines (after filtering). Defaults to 200.'),
    filter: z
        .string()
        .optional()
        .describe(
            'Case-insensitive regular expression; only matching lines are returned. Falls back to a plain substring match if the pattern is not valid regex.',
        ),
});

// Plugin consoles are colourised for the web UI; the ANSI escapes are noise to an LLM.
// Matching ESC is the point of this pattern, so the control-character lint does not apply.
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

// The console read port (plugin-console.ts in the server) takes the device's nativeId as its
// first line ("undefined" for the plugin root), replies with the buffered history, then keeps
// streaming live output. We take the history and hang up once the socket goes quiet.
const CONSOLE_IDLE_MS = 400;
const CONSOLE_MAX_MS = 5000;

async function readConsoleViaPort(plugins: PluginComponent, id: string): Promise<string> {
    const dev = systemManager.getDeviceById(id) as { pluginId?: string; nativeId?: string } | undefined;
    if (!dev?.pluginId) throw new Error(`device ${id} not found`);
    const [port, host] = await plugins.getRemoteServicePort(dev.pluginId, 'console');
    return new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        const socket = net.connect(port, host || '127.0.0.1');
        let idle: NodeJS.Timeout | undefined;
        const finish = () => {
            clearTimeout(idle);
            clearTimeout(deadline);
            socket.destroy();
            resolve(Buffer.concat(chunks).toString());
        };
        const deadline = setTimeout(finish, CONSOLE_MAX_MS);
        socket.on('connect', () => {
            socket.write(`${dev.nativeId ?? 'undefined'}\n`);
            // An empty console never sends anything, so arm the idle timer up front too.
            idle = setTimeout(finish, CONSOLE_IDLE_MS);
        });
        socket.on('data', (data: Buffer) => {
            chunks.push(data);
            clearTimeout(idle);
            idle = setTimeout(finish, CONSOLE_IDLE_MS);
        });
        socket.on('error', e => {
            clearTimeout(idle);
            clearTimeout(deadline);
            reject(e);
        });
        socket.on('close', finish);
    });
}

export async function readConsole(args: z.infer<typeof readConsoleInput>) {
    const plugins = await getComponent<PluginComponent>('plugins');
    let raw: string;
    try {
        raw = (await plugins.readConsole(args.id)) ?? '';
    } catch (e: any) {
        // RPC proxies can't be feature-tested ahead of time; the server reports a missing
        // method as this error, which is the signal to use the older port protocol.
        if (!/does not have method readConsole/.test(String(e?.message))) throw e;
        raw = await readConsoleViaPort(plugins, args.id);
    }
    let lines = raw.replace(ANSI_ESCAPE, '').split(/\r?\n/);
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    const totalLines = lines.length;
    if (args.filter) {
        let match: (l: string) => boolean;
        try {
            const re = new RegExp(args.filter, 'i');
            match = l => re.test(l);
        } catch {
            const needle = args.filter.toLowerCase();
            match = l => l.toLowerCase().includes(needle);
        }
        lines = lines.filter(match);
    }
    const matchedLines = lines.length;
    const tail = args.tail ?? 200;
    const truncated = lines.length > tail;
    if (truncated) lines = lines.slice(-tail);
    return { id: args.id, totalLines, matchedLines, returnedLines: lines.length, truncated, text: lines.join('\n') };
}
