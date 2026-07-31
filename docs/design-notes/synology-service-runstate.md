# Synology service run-state — why DSM can't answer it, and what could

**Status:** investigated, not built. No issue filed.
**Date:** 2026-07-31. Observed against one DSM 7 NAS.

## The problem

The `services` entry in `SynologyCatalog` returns `enable_status` per
service, with values `enabled` / `disabled` / `static`. That is the
state of a DSM control-panel checkbox — configuration, not runtime.
`static` means "not user-togglable", which is a statement about the UI
rather than about the daemon.

So a dashboard built on this data can show *what an admin turned on*.
It cannot show *what is actually running*. Those are different
questions, and they have different answers on a real box.

DSM offers no way to close the gap. Checked against the full 632-API
`SYNO.API.Info` enumeration:

- `SYNO.Core.Service.Info` — does not exist
- `SYNO.Core.Service.PortInfo` — exists, rejects `get` and `list` (103)
- `SYNO.Core.Service.Conf` — returns one global field,
  `service_fw_target_interface` (firewall config, not per-service)

## The observation that motivates this

The services DSM lists are stock Linux daemons — `sshd`, `nfsd`,
`smbd`, `snmpd`, `rsyncd`, `cupsd`, `tftp`. They hold socket
endpoints, so their liveness is observable from outside DSM entirely,
by connecting to the port.

A TCP sweep of the 17 mappable services, run alongside the DSM query,
disagreed with `enable_status` on several rows:

| service              | port | DSM        | TCP    | reading                          |
|----------------------|------|------------|--------|----------------------------------|
| `ssh-shell`          | 22   | `enabled`  | OPEN   | agrees                           |
| `nfs-server`         | 2049 | `enabled`  | OPEN   | agrees                           |
| `pkg-synosamba-smbd` | 445  | `enabled`  | OPEN   | agrees                           |
| `synoscgi`           | 5001 | `static`   | OPEN   | agrees                           |
| **`ups-net`**        | 3493 | `disabled` | OPEN   | **listening despite toggle off** |
| `sftp`               | 22   | `disabled` | OPEN   | false positive — shares port 22  |
| `snmpd`              | 161  | `static`   | closed | UDP — wrong test                 |
| `cupsd`              | 631  | `static`   | closed | localhost-bound                  |
| `pkg-iscsi`          | 3260 | `static`   | closed | `static` ≠ running               |

`ups-net` is the case that proves the two signals are independent.
The three `static`-but-closed rows show `static` carries no runtime
meaning.

## Why "port open = healthy" would be wrong

A naive probe panel misreports at least 4 of 17 rows above. The
failure modes are structural, not tuning problems:

1. **Port ≠ service.** `ssh-shell` and `sftp` both map to 22. A probe
   cannot distinguish them, so `sftp` inherits SSH's state regardless
   of its own setting. Any multiplexed service has this problem.
2. **UDP is not testable by TCP connect.** `snmpd` (161),
   `bonjour` (5353), `tftp` (69) are UDP. A TCP connect to a UDP port
   always reads closed — three guaranteed false negatives.
3. **Localhost-bound daemons look dead.** `cupsd` on 631 is almost
   certainly running, bound to `127.0.0.1`. From off-box it is
   indistinguishable from stopped.
4. **A firewall makes everything look closed.** DSM has one, per
   interface. `filtered/timeout` vs `closed` separates drop from
   reject, but a rejecting firewall still reads exactly like a dead
   daemon.

Worth keeping separate: **is the daemon listening** (TCP connect,
cheap, generic) vs. **is it healthy** (protocol handshake,
per-service, expensive). Only the first is realistically generic.

## Two ways to build it, if it's ever wanted

**TCP reachability probe** — a connection type that dials a
host/port list on an interval. Generic, no DSM coupling, no
credentials, reusable well beyond the NAS. Limited to TCP, and
honestly reports *reachability from the dashboard host* rather than
health. That framing is arguably more useful anyway, since
reachability is what affects clients.

**On-box query over SSH** — `systemctl is-active` or `ss -lntup`
gives true daemon state including UDP and localhost binds, with no
ambiguity. Viable here (SSH is enabled), but a much heavier
dependency: credentials, a shell channel, and an adapter that runs
remote commands. That is an architectural addition, not a tweak.

Either way this is a **new capability, separate from the Synology
adapter**. DSM has no run-state to expose, so it cannot be a catalog
entry.

## Related

- [connections.md → `api.synology` → DSM API limits](../architecture/connections.md)
