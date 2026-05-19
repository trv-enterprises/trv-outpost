// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package streaming

import (
	"fmt"
	"net"
	"os"
	"strings"
)

// serverPort holds the port the HTTP server is listening on, set once
// at startup via SetServerPort. Used to build the inbound callback URL
// for ts-store push connections when DASHBOARD_HOST is unset.
var serverPort = 3001

// SetServerPort is called once from main() so this package can build
// reachable callback URLs without having to dig the port out of config
// at every TSStore stream creation.
func SetServerPort(p int) {
	if p > 0 {
		serverPort = p
	}
}

// DashboardHostPort returns the host:port suggestion remote ts-store
// instances can reach this dashboard at. Same resolution order as
// getDashboardHost on TSStoreStream — DASHBOARD_HOST env wins, then
// autodiscovered LAN/overlay IP, then localhost:<port> as the
// last-resort fallback. Exposed so other parts of the codebase that
// need to construct a dashboard-pointing URL (e.g. the alert-rule
// wizard's default webhook target) share one consistent answer.
func DashboardHostPort() string {
	if host := os.Getenv("DASHBOARD_HOST"); host != "" {
		return host
	}
	if ip := discoverReachableHostIP(); ip != "" {
		return fmt.Sprintf("%s:%d", ip, serverPort)
	}
	return fmt.Sprintf("localhost:%d", serverPort)
}

// discoverReachableHostIP picks an IP address on this machine that
// remote ts-store nodes can plausibly dial back to. Used only when
// DASHBOARD_HOST is unset (the env var always wins for production).
//
// Selection rules, in order:
//
//  1. Prefer overlay-network interfaces (Tailscale, ZeroTier,
//     WireGuard, etc.) by interface name pattern. These are the
//     interfaces most likely to be reachable from a different host
//     in a multi-machine dev or hybrid setup.
//  2. Otherwise pick the first physical-LAN interface whose IPv4
//     falls inside one of the safe RFC1918 private ranges, excluding
//     Docker bridge networks that are unreachable off-host.
//  3. If nothing qualifies, return "" so the caller can fall back to
//     localhost (which only works when ts-store runs on this host).
//
// The Docker exclusion is the lesson from v0.6.4: an earlier version
// of this discovery picked the Docker bridge IP first because it was
// up and "private," which produced unroutable callback URLs in
// production. The current rule is allowlist-based: we only return an
// address that's both private and on a non-excluded interface.
func discoverReachableHostIP() string {
	ifaces, err := net.Interfaces()
	if err != nil {
		return ""
	}

	var overlayIP, lanIP string

	for _, iface := range ifaces {
		// Skip down or loopback interfaces outright.
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		// Skip Docker bridge interfaces by name. Even if a Docker
		// IP sneaks into the safe-subnet check below, this is a
		// belt-and-suspenders guard.
		if isDockerInterface(iface.Name) {
			continue
		}

		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			ipNet, ok := addr.(*net.IPNet)
			if !ok {
				continue
			}
			ip4 := ipNet.IP.To4()
			if ip4 == nil || ip4.IsLoopback() || ip4.IsLinkLocalUnicast() {
				continue
			}
			if !isSafePrivateIPv4(ip4) {
				continue
			}

			candidate := ip4.String()
			if isOverlayInterface(iface.Name) {
				// First overlay match wins and we can stop early.
				if overlayIP == "" {
					overlayIP = candidate
				}
			} else if lanIP == "" {
				lanIP = candidate
			}
		}
	}

	if overlayIP != "" {
		return overlayIP
	}
	return lanIP
}

// isOverlayInterface returns true for interface names typically used
// by VPN or overlay-network stacks: macOS Tailscale (utun*), Linux
// Tailscale (tailscale*), WireGuard (wg*), ZeroTier (zt*), and
// generic tunnels (tun*).
func isOverlayInterface(name string) bool {
	lower := strings.ToLower(name)
	prefixes := []string{"utun", "tailscale", "wg", "zt", "tun"}
	for _, p := range prefixes {
		if strings.HasPrefix(lower, p) {
			return true
		}
	}
	return false
}

// isDockerInterface returns true for interface names that belong to
// Docker bridge networks. Docker bridges are unreachable from other
// hosts, so we never want to advertise them as the dashboard's
// callback address.
func isDockerInterface(name string) bool {
	lower := strings.ToLower(name)
	prefixes := []string{"docker", "br-", "veth"}
	for _, p := range prefixes {
		if strings.HasPrefix(lower, p) {
			return true
		}
	}
	return false
}

// isSafePrivateIPv4 returns true if ip is in one of the RFC1918
// private ranges or the Tailscale CGNAT range, AND not in a Docker
// bridge sub-range. Docker's default bridge uses 172.17.0.0/16 and
// docker-compose typically allocates 172.18-172.29/16; both produce
// unroutable callback URLs from off-host.
func isSafePrivateIPv4(ip net.IP) bool {
	if ip == nil {
		return false
	}
	for _, blocked := range dockerBlockedCIDRs {
		if blocked.Contains(ip) {
			return false
		}
	}
	for _, allowed := range safePrivateCIDRs {
		if allowed.Contains(ip) {
			return true
		}
	}
	return false
}

// safePrivateCIDRs is the allowlist of address ranges we'll consider
// for the discovered host IP. Pre-parsed once at package init.
var safePrivateCIDRs = mustParseCIDRs(
	"10.0.0.0/8",       // RFC1918
	"172.16.0.0/12",    // RFC1918 (Docker sub-ranges blocked separately below)
	"192.168.0.0/16",   // RFC1918
	"100.64.0.0/10",    // CGNAT — used by Tailscale and some other overlays
)

// dockerBlockedCIDRs are sub-ranges inside RFC1918 that Docker
// commonly uses for bridge networks. We block these even though they
// fall inside safePrivateCIDRs because Docker bridges are unreachable
// from other hosts.
var dockerBlockedCIDRs = mustParseCIDRs(
	"172.17.0.0/16", // default Docker bridge
	"172.18.0.0/16", // common docker-compose default range
	"172.19.0.0/16",
	"172.20.0.0/16",
	"172.21.0.0/16",
	"172.22.0.0/16",
	"172.23.0.0/16",
	"172.24.0.0/16",
	"172.25.0.0/16",
	"172.26.0.0/16",
	"172.27.0.0/16",
	"172.28.0.0/16",
	"172.29.0.0/16",
)

func mustParseCIDRs(cidrs ...string) []*net.IPNet {
	out := make([]*net.IPNet, 0, len(cidrs))
	for _, c := range cidrs {
		_, n, err := net.ParseCIDR(c)
		if err != nil {
			// Hard panic at package init is fine; these are constants.
			panic("invalid CIDR in host_discovery: " + c + ": " + err.Error())
		}
		out = append(out, n)
	}
	return out
}
