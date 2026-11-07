import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { systemManager } from '../scrypted';

// First-class wrappers for the device lifecycle a camera setup needs: discover/create a device
// through its provider plugin (ONVIF, Reolink, ...), read and write its settings (including
// settings contributed by mixins such as NVR, object detection, HomeKit), rename it, and remove
// it. Everything here is reachable through call_device_method too, except removal — that lives
// on systemManager, not on a device — but the dedicated tools give the LLM typed inputs and a
// compact, masked view of Setting[] instead of raw RPC payloads.

// Setting values the SDK allows (SettingValue is effectively any JSON scalar or string[]).
const settingValue = z.any();

// Mirror of the restore_backup tripwire, but bound to the target id so a confirm string
// copied from one call can't arm the removal of a different device.
function removeTripwire(id: string) {
    return `REMOVE DEVICE ${id}`;
}

const PASSWORD_MASK = '********';

interface SettingLike {
    key?: string;
    title?: string;
    group?: string;
    subgroup?: string;
    description?: string;
    type?: string;
    value?: unknown;
    choices?: string[];
    range?: [number, number];
    readonly?: boolean;
    multiple?: boolean;
    placeholder?: string;
}

// Compact a Setting[] for the LLM: drop UI-only fields (icons, console, radioGroups, ...),
// skip html blobs, and mask password values unless the caller explicitly opts in.
function summarizeSettings(settings: SettingLike[] | undefined, revealPasswords = false) {
    return (settings ?? [])
        .filter(s => s.type !== 'html')
        .map(s => ({
            key: s.key,
            title: s.title,
            group: s.group,
            subgroup: s.subgroup,
            type: s.type ?? 'string',
            value: s.type === 'password' && !revealPasswords && s.value ? PASSWORD_MASK : s.value,
            choices: s.choices,
            range: s.range,
            multiple: s.multiple || undefined,
            readonly: s.readonly || undefined,
            placeholder: s.placeholder,
            description: s.description,
        }));
}

function getDeviceOrThrow(id: string): any {
    const dev = systemManager.getDeviceById(id) as any;
    if (!dev) throw new Error(`device ${id} not found`);
    return dev;
}

function requireInterface(dev: any, iface: string) {
    const interfaces: string[] = dev.interfaces ?? [];
    if (!interfaces.includes(iface)) throw new Error(`device ${dev.id} (${dev.name}) does not implement ${iface}`);
}

function deviceSummary(id: string) {
    const dev = systemManager.getDeviceById(id) as any;
    if (!dev) return { id };
    return {
        id,
        name: dev.name,
        type: dev.type,
        pluginId: dev.pluginId,
        providerId: dev.providerId,
        nativeId: dev.nativeId,
        room: dev.room,
        interfaces: dev.interfaces,
    };
}

export const listDeviceCreatorsInput = z.object({});

export async function listDeviceCreators() {
    const state = systemManager.getSystemState();
    const out: Array<{
        id: string;
        name: string;
        pluginId?: string;
        canCreate: boolean;
        canDiscover: boolean;
    }> = [];
    for (const id of Object.keys(state)) {
        const dev = state[id];
        const interfaces: string[] = dev?.interfaces?.value ?? [];
        const canCreate = interfaces.includes('DeviceCreator');
        const canDiscover = interfaces.includes('DeviceDiscovery');
        if (!canCreate && !canDiscover) continue;
        out.push({ id, name: dev?.name?.value ?? '', pluginId: dev?.pluginId?.value, canCreate, canDiscover });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return { count: out.length, creators: out };
}

export const getCreateDeviceSettingsInput = z.object({
    providerId: z
        .string()
        .describe('Device id of a DeviceCreator (from list_device_creators), e.g. the ONVIF or Reolink plugin.'),
});

export async function getCreateDeviceSettings(args: z.infer<typeof getCreateDeviceSettingsInput>) {
    const provider = getDeviceOrThrow(args.providerId);
    requireInterface(provider, 'DeviceCreator');
    const settings = await provider.getCreateDeviceSettings();
    return { providerId: args.providerId, provider: provider.name, settings: summarizeSettings(settings, true) };
}

export const createDeviceInput = z.object({
    providerId: z.string().describe('Device id of a DeviceCreator (from list_device_creators).'),
    settings: z
        .record(z.string(), settingValue)
        .describe(
            'Map of setting key → value, using the keys returned by get_create_device_settings (typically name, ip/host, username, password, ...).',
        ),
});

export async function createDevice(args: z.infer<typeof createDeviceInput>) {
    const provider = getDeviceOrThrow(args.providerId);
    requireInterface(provider, 'DeviceCreator');
    const id: string = await provider.createDevice(args.settings);
    return { created: deviceSummary(id) };
}

export const discoverDevicesInput = z.object({
    providerId: z.string().describe('Device id of a DeviceDiscovery provider (from list_device_creators).'),
    scan: z
        .boolean()
        .optional()
        .describe('Run a fresh network scan instead of returning previously discovered devices. Defaults to false.'),
});

export async function discoverDevices(args: z.infer<typeof discoverDevicesInput>) {
    const provider = getDeviceOrThrow(args.providerId);
    requireInterface(provider, 'DeviceDiscovery');
    const found: any[] = (await provider.discoverDevices(args.scan ?? false)) ?? [];
    return {
        count: found.length,
        devices: found.map(d => ({
            nativeId: d.nativeId,
            name: d.name,
            description: d.description,
            type: d.type,
            info: d.info,
            adoptSettings: summarizeSettings(d.settings, true),
        })),
    };
}

export const adoptDeviceInput = z.object({
    providerId: z.string().describe('Device id of a DeviceDiscovery provider (from list_device_creators).'),
    nativeId: z.string().describe('nativeId of the discovered device (from discover_devices).'),
    settings: z
        .record(z.string(), settingValue)
        .optional()
        .describe('Values for the `adoptSettings` keys returned by discover_devices (e.g. username, password).'),
});

export async function adoptDevice(args: z.infer<typeof adoptDeviceInput>) {
    const provider = getDeviceOrThrow(args.providerId);
    requireInterface(provider, 'DeviceDiscovery');
    const id: string = await provider.adoptDevice({ nativeId: args.nativeId, settings: args.settings ?? {} });
    return { adopted: deviceSummary(id) };
}

export const getDeviceSettingsInput = z.object({
    id: z.string().describe('Scrypted device id (from list_devices).'),
    group: z
        .string()
        .optional()
        .describe(
            'Case-insensitive substring filter on the setting group or subgroup (e.g. "Recording", "Object Detection", "Snapshot"). Cameras expose hundreds of settings across mixins; filter when you know the area.',
        ),
    revealPasswords: z
        .boolean()
        .optional()
        .describe('Return password values in clear text. Defaults to false (masked as ********).'),
});

export async function getDeviceSettings(args: z.infer<typeof getDeviceSettingsInput>) {
    const dev = getDeviceOrThrow(args.id);
    requireInterface(dev, 'Settings');
    // Settings on a mixed device are the merged view: the device's own settings plus every
    // mixin's, with mixin keys namespaced (e.g. "<mixinId>:key"). put_device_setting takes the
    // key exactly as returned here and the runtime routes it to the right mixin.
    let settings = summarizeSettings(await dev.getSettings(), args.revealPasswords ?? false);
    const needle = args.group?.toLowerCase();
    if (needle)
        settings = settings.filter(
            s => s.group?.toLowerCase().includes(needle) || s.subgroup?.toLowerCase().includes(needle),
        );
    const groups = [...new Set(settings.map(s => s.group ?? ''))];
    return { id: args.id, name: dev.name, count: settings.length, groups, settings };
}

export const putDeviceSettingInput = z.object({
    id: z.string().describe('Scrypted device id (from list_devices).'),
    key: z.string().describe('Setting key exactly as returned by get_device_settings (including any mixin prefix).'),
    value: settingValue.describe(
        'New value. Use the type shown by get_device_settings: string, number, boolean, or string[] for `multiple` settings. For `button` settings pass null to press it.',
    ),
});

export async function putDeviceSetting(args: z.infer<typeof putDeviceSettingInput>) {
    const dev = getDeviceOrThrow(args.id);
    requireInterface(dev, 'Settings');
    await dev.putSetting(args.key, args.value);
    // Read back so the caller sees what actually stuck (providers may coerce or reject silently).
    const after = summarizeSettings(await dev.getSettings()).find(s => s.key === args.key);
    return { id: args.id, key: args.key, value: after ? after.value : null, found: !!after };
}

export const setDeviceInfoInput = z.object({
    id: z.string().describe('Scrypted device id (from list_devices).'),
    name: z.string().optional().describe('New display name.'),
    room: z.string().optional().describe('New room.'),
    type: z.string().optional().describe('New ScryptedDeviceType (e.g. "Camera", "Doorbell").'),
});

export async function setDeviceInfo(args: z.infer<typeof setDeviceInfoInput>) {
    const dev = getDeviceOrThrow(args.id);
    if (args.name === undefined && args.room === undefined && args.type === undefined)
        throw new Error('pass at least one of name, room, type');
    if (args.name !== undefined) await dev.setName(args.name);
    if (args.room !== undefined) await dev.setRoom(args.room);
    if (args.type !== undefined) await dev.setType(args.type);
    // System state lags the setter by a tick, so overlay the values we just wrote rather than
    // reporting the pre-change name back to the caller.
    const summary = deviceSummary(args.id);
    return {
        updated: {
            ...summary,
            ...(args.name !== undefined && { name: args.name }),
            ...(args.room !== undefined && { room: args.room }),
            ...(args.type !== undefined && { type: args.type }),
        },
    };
}

export const removeDeviceInput = z.object({
    id: z.string().describe('Scrypted device id to remove (from list_devices).'),
    confirm: z
        .string()
        .describe(
            'Confirmation tripwire. Must be the exact string "REMOVE DEVICE <id>" for the same id. Independent of the user\'s elicitation response.',
        ),
});

// Same three-gate shape as restore_backup: tripwire argument, mandatory elicitation, and
// destructiveHint on registration. Returned as a factory so the handler can reach the live
// McpServer for the elicitation round-trip.
export function makeRemoveDeviceHandler(server: McpServer) {
    return async function removeDevice(args: z.infer<typeof removeDeviceInput>) {
        const expected = removeTripwire(args.id);
        if (args.confirm !== expected)
            throw new Error(
                `confirm must equal "${expected}" verbatim. The agent must surface this removal to the user before calling remove_device.`,
            );

        const dev = getDeviceOrThrow(args.id);
        // A plugin's own device has no nativeId; removing it uninstalls the whole plugin and
        // every device it provides. That is a different operation with a much larger blast
        // radius, so refuse rather than let a device-level tool do it.
        if (dev.nativeId === undefined || dev.nativeId === null)
            throw new Error(
                `device ${args.id} (${dev.name}) is a plugin's root device; removing it would uninstall plugin ${dev.pluginId}. remove_device only removes devices provided by a plugin.`,
            );

        const caps = server.server.getClientCapabilities();
        if (!caps?.elicitation)
            throw new Error(
                'remove_device requires a client that supports MCP elicitation; this client did not advertise the capability.',
            );

        const elicitation = await server.server.elicitInput({
            message: [
                `About to permanently remove device ${args.id} "${dev.name}" (type ${dev.type}, plugin ${dev.pluginId}).`,
                'Its settings and mixin configuration are deleted. Recordings already on disk are not deleted by this call.',
                'Choose REMOVE to proceed or CANCEL to abort.',
            ].join(' '),
            requestedSchema: {
                type: 'object',
                properties: {
                    confirm: {
                        type: 'string',
                        title: 'Confirm removal',
                        description: 'Choose REMOVE to proceed or CANCEL to abort.',
                        enum: ['REMOVE', 'CANCEL'],
                    },
                },
                required: ['confirm'],
            },
        });

        if (elicitation.action !== 'accept') return { removed: false, reason: `user ${elicitation.action}ed` };
        const elicitedConfirm = elicitation.content?.confirm;
        if (elicitedConfirm !== 'REMOVE')
            return { removed: false, reason: `user did not confirm (got: ${String(elicitedConfirm)})` };

        const summary = deviceSummary(args.id);
        await systemManager.removeDevice(args.id);
        return { removed: true, device: summary };
    };
}
