//go:build linux

// marina-init is PID 1 on marina's own kernel. It mounts API filesystems and the
// data disk, brings up the virtio NIC, reaps zombies, and supervises marina-agent.
package main

import (
	"log"
	"os"
	"os/exec"
	"os/signal"
	"syscall"
	"time"
)

const (
	agentPath = "/opt/marina/bin/marina-agent"
	dataRoot  = "/var/lib/marina"
	appRoot   = "/opt/marina"
)

func main() {
	log.SetPrefix("marina-init: ")
	log.SetFlags(0)

	if os.Getpid() != 1 {
		log.Printf("warning: not running as PID 1 (pid %d)", os.Getpid())
	}
	if os.Getenv("PATH") == "" {
		_ = os.Setenv("PATH", "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin")
	}
	_ = syscall.Sethostname([]byte("marina"))
	mountEssentials()
	setClockFromCmdline()
	dev := os.Getenv("MARINA_DATA_DEVICE")
	if dev == "" {
		dev = "/dev/vdb"
	}
	mountData(dev, dataRoot)
	ensureDataLayout(dataRoot)
	bringUpNet()
	startPortProxies()

	sigCh := make(chan os.Signal, 8)
	signal.Notify(sigCh, syscall.SIGCHLD, syscall.SIGTERM, syscall.SIGINT, syscall.SIGHUP)

	var agentPid int
	exited := make(chan struct{}, 1)
	startAgent := func() bool {
		cmd := exec.Command(agentPath)
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		cmd.Env = append(os.Environ(),
			"MARINA_HOME="+dataRoot,
			"MARINA_APP_ROOT="+appRoot,
			"MARINA_INSIDE_LINUX=1",
			// QEMU forwards the host's 127.0.0.1:4761 to the guest NIC, not to loopback.
			"MARINA_AGENT_LISTEN=0.0.0.0:4761",
		)
		cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
		if err := cmd.Start(); err != nil {
			log.Printf("agent: %v", err)
			agentPid = 0
			return false
		}
		agentPid = cmd.Process.Pid
		log.Printf("agent pid %d", agentPid)
		return true
	}
	if !startAgent() {
		time.Sleep(time.Second)
	}

	stopping := false
	for {
		select {
		case sig := <-sigCh:
			switch sig {
			case syscall.SIGCHLD:
				reap(agentPid, exited)
			default:
				stopping = true
				signalAgent(agentPid, syscall.SIGTERM)
			}
		case <-exited:
			if stopping {
				os.Exit(0)
			}
			log.Printf("agent exited; restarting")
			time.Sleep(time.Second)
			startAgent()
		case <-time.After(10 * time.Second):
			if stopping {
				signalAgent(agentPid, syscall.SIGKILL)
				os.Exit(0)
			}
			if agentPid == 0 {
				startAgent()
			}
		}
	}
}

func signalAgent(pid int, sig syscall.Signal) {
	if pid <= 0 {
		return
	}
	_ = syscall.Kill(-pid, sig)
}

func reap(agentPid int, exited chan<- struct{}) {
	for {
		var ws syscall.WaitStatus
		pid, err := syscall.Wait4(-1, &ws, syscall.WNOHANG, nil)
		if pid <= 0 || err != nil {
			return
		}
		if pid == agentPid {
			select {
			case exited <- struct{}{}:
			default:
			}
		}
	}
}
