//go:build linux

package main

import (
	"context"
	"log"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"time"
)

func mountEssentials() {
	ensureMount("/proc", "proc", "proc", "")
	ensureMount("/sys", "sysfs", "sysfs", "")
	ensureMount("/dev", "devtmpfs", "devtmpfs", "")
	_ = os.MkdirAll("/dev/pts", 0o755)
	_ = os.MkdirAll("/dev/shm", 0o755)
	ensureMount("/dev/pts", "devpts", "devpts", "gid=5,mode=620")
	ensureMount("/dev/shm", "tmpfs", "tmpfs", "")
}

func mountData(dev, target string) {
	if err := os.MkdirAll(target, 0o755); err != nil {
		log.Printf("data root: %v", err)
		return
	}
	if _, err := os.Stat(dev); err != nil {
		log.Printf("data disk %s is not attached; using %s on the rootfs", dev, target)
		return
	}
	if mounted(target) {
		return
	}
	if err := syscall.Mount(dev, target, "ext4", 0, ""); err != nil {
		log.Printf("mount %s on %s: %v", dev, target, err)
	}
}

func ensureDataLayout(root string) {
	for _, name := range []string{"engines", "data", "etc", "logs", "run", "cache", "shims", "tmp"} {
		if err := os.MkdirAll(root+"/"+name, 0o755); err != nil {
			log.Printf("mkdir %s/%s: %v", root, name, err)
		}
	}
}

func ensureMount(target, fstype, source, data string) {
	if mounted(target) {
		return
	}
	if err := os.MkdirAll(target, 0o755); err != nil {
		log.Printf("mkdir %s: %v", target, err)
		return
	}
	if err := syscall.Mount(source, target, fstype, 0, data); err != nil {
		log.Printf("mount %s: %v", target, err)
	}
}

func setClockFromCmdline() {
	raw, err := os.ReadFile("/proc/cmdline")
	if err != nil {
		log.Printf("cmdline: %v", err)
		return
	}
	for _, field := range strings.Fields(string(raw)) {
		const prefix = "marina.epoch="
		if !strings.HasPrefix(field, prefix) {
			continue
		}
		sec, err := strconv.ParseInt(strings.TrimPrefix(field, prefix), 10, 64)
		if err != nil {
			log.Printf("marina.epoch: %v", err)
			return
		}
		if err := syscall.Settimeofday(&syscall.Timeval{Sec: sec}); err != nil {
			log.Printf("settimeofday: %v", err)
		}
		return
	}
}

func bringUpNet() {
	if _, err := os.Stat("/sys/class/net/eth0"); err != nil {
		log.Printf("no eth0; database installs need the virtio NIC")
		return
	}
	run("ip", "link", "set", "lo", "up")
	run("ip", "link", "set", "eth0", "up")
	if runTimeout(10*time.Second, "dhclient", "-1", "eth0") == nil {
		return
	}
	// QEMU user-mode NAT when there is no DHCP client.
	run("ip", "addr", "add", "10.0.2.15/24", "dev", "eth0")
	run("ip", "route", "add", "default", "via", "10.0.2.2")
	if err := os.WriteFile("/etc/resolv.conf", []byte("nameserver 10.0.2.3\n"), 0o644); err != nil {
		log.Printf("resolv.conf: %v", err)
	}
}

func run(name string, args ...string) error {
	return runTimeout(5*time.Second, name, args...)
}

func runTimeout(limit time.Duration, name string, args ...string) error {
	ctx, cancel := context.WithTimeout(context.Background(), limit)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	err := cmd.Run()
	if err != nil {
		log.Printf("%s: %v", name, err)
	}
	return err
}

func mounted(target string) bool {
	body, err := os.ReadFile("/proc/mounts")
	if err != nil {
		return false
	}
	return strings.Contains("\n"+string(body), " "+target+" ")
}
