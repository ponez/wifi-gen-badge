import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import NM from 'gi://NM';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

const POLL_SECONDS = 30;
const WAIT_MS = 500;
const WAIT_TRIES = 40;
const SIX_GHZ_START_MHZ = 5925;

// Checked in order: "EHT-MCS" and "VHT-MCS" also contain "HT-MCS".
const MODULATIONS = [
    ['EHT-MCS', 7],
    ['HE-MCS', 6],
    ['VHT-MCS', 5],
    [' MCS ', 4],
];

function parseGeneration(iwLinkOutput) {
    let generation = 0;
    for (const line of iwLinkOutput.split('\n')) {
        if (!/(rx|tx) bitrate:/.test(line))
            continue;
        const match = MODULATIONS.find(([token]) => line.includes(token));
        if (match)
            generation = Math.max(generation, match[1]);
    }
    return generation;
}

function badgeText(generation, frequencyMhz) {
    if (!generation)
        return '';
    if (generation === 6 && frequencyMhz >= SIX_GHZ_START_MHZ)
        return '6E';
    return String(generation);
}

export default class WifiGenBadgeExtension extends Extension {
    enable() {
        this._cancellable = new Gio.Cancellable();
        this._waitTries = 0;
        if (this._tryAttach())
            return;

        this._waitId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, WAIT_MS, () => {
            if (this._tryAttach() || ++this._waitTries >= WAIT_TRIES) {
                this._waitId = 0;
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    disable() {
        if (this._waitId)
            GLib.Source.remove(this._waitId);
        if (this._pollId)
            GLib.Source.remove(this._pollId);
        this._waitId = 0;
        this._pollId = 0;

        this._cancellable.cancel();
        this._cancellable = null;

        this._client?.disconnectObject(this);
        this._client = null;

        if (this._wrapper)
            this._detach();
    }

    // The quick settings indicators are created asynchronously, so the
    // network indicator may not exist yet when the extension is enabled.
    _tryAttach() {
        const network = Main.panel.statusArea.quickSettings._network;
        if (network === null)
            return true;
        if (!network?._primaryIndicator)
            return false;

        this._attach(network);
        return true;
    }

    _attach(network) {
        this._network = network;
        this._icon = network._primaryIndicator;

        this._wrapper = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            y_align: Clutter.ActorAlign.CENTER,
            // Keep the badge's expand flags from widening the panel slot.
            x_expand: false,
            y_expand: false,
        });
        this._badge = new St.Label({
            style_class: 'wifi-gen-badge',
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.END,
            x_expand: true,
            y_expand: true,
            visible: false,
        });
        this._wrapper.connectObject(
            'notify::width', () => this._placeBadge(),
            'notify::height', () => this._placeBadge(),
            this);

        const index = network.get_children().indexOf(this._icon);
        network.remove_child(this._icon);
        this._wrapper.add_child(this._icon);
        this._wrapper.add_child(this._badge);
        network.insert_child_at_index(this._wrapper, index);

        this._icon.connectObject(
            'notify::visible', () => this._syncVisible(),
            'notify::icon-name', () => this._refresh(),
            this);
        this._syncVisible();

        NM.Client.new_async(this._cancellable, (_source, result) => {
            try {
                this._client = NM.Client.new_finish(result);
            } catch (e) {
                if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    console.error('wifi-gen-badge: no NetworkManager client', e);
                return;
            }
            this._client.connectObject(
                'notify::primary-connection', () => this._refresh(),
                this);
            this._refresh();
        });

        this._pollId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, POLL_SECONDS, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _detach() {
        this._icon.disconnectObject(this);

        const index = this._network.get_children().indexOf(this._wrapper);
        this._wrapper.remove_child(this._icon);
        this._network.insert_child_at_index(this._icon, index);
        this._badge.destroy();
        this._wrapper.destroy();
        this._network._syncIndicatorsVisible();

        this._wrapper = null;
        this._badge = null;
        this._icon = null;
        this._network = null;
    }

    // Pin the badge to the glyph's bottom-right corner rather than the icon
    // box, since themes pad the box differently. Starting at the glyph's
    // right edge also lets wider text like "6E" grow away from the arcs.
    _placeBadge() {
        const iconSize = this._icon.get_theme_node().get_length('icon-size');
        this._badge.translation_x = Math.round((this._wrapper.width + iconSize) / 2);
        this._badge.translation_y = -Math.round((this._wrapper.height - iconSize) / 2);
    }

    _syncVisible() {
        this._wrapper.visible = this._icon.visible;
        this._badge.visible = this._badge.text !== '' &&
            (this._icon.icon_name?.startsWith('network-wireless') ?? false);
        // The indicator only re-checks its children when the icon itself
        // changes visibility, before the wrapper has caught up.
        this._network._syncIndicatorsVisible();
    }

    async _refresh() {
        if (this._refreshing) {
            this._refreshQueued = true;
            return;
        }
        this._refreshing = true;

        let text = '';
        try {
            text = await this._readBadgeText();
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED) && !this._loggedError) {
                this._loggedError = true;
                console.error('wifi-gen-badge: reading the Wi-Fi link failed', e);
            }
        }
        this._refreshing = false;

        if (!this._badge)
            return;
        this._badge.text = text;
        this._syncVisible();

        if (this._refreshQueued) {
            this._refreshQueued = false;
            this._refresh();
        }
    }

    async _readBadgeText() {
        const devices = this._client?.primary_connection?.get_devices() ?? [];
        const device = devices.find(d => d instanceof NM.DeviceWifi);
        const accessPoint = device?.active_access_point;
        if (!accessPoint)
            return '';

        const proc = Gio.Subprocess.new(
            ['iw', 'dev', device.get_iface(), 'link'],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        const [stdout] = await proc.communicate_utf8_async(null, this._cancellable);
        return badgeText(parseGeneration(stdout ?? ''), accessPoint.frequency);
    }
}
