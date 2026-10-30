//go:build linux

package main

import (
	"io"
	"log"
	"net"
)

// Engines keep binding 127.0.0.1. QEMU's hostfwd arrives on the virtio NIC,
// so these ports are accepted there and handed to the loopback listener.
var proxyPorts = []string{"3306", "3307", "5432", "27017", "6379", "11211"}

func startPortProxies() {
	ip := guestIPv4()
	if ip == "" {
		log.Printf("proxy: eth0 has no IPv4 address; host ports stay closed")
		return
	}
	for _, port := range proxyPorts {
		go proxyPort(ip, port)
	}
}

func guestIPv4() string {
	iface, err := net.InterfaceByName("eth0")
	if err != nil {
		log.Printf("proxy: %v", err)
		return ""
	}
	addrs, err := iface.Addrs()
	if err != nil {
		log.Printf("proxy: %v", err)
		return ""
	}
	for _, addr := range addrs {
		ipnet, ok := addr.(*net.IPNet)
		if ok && ipnet.IP.To4() != nil {
			return ipnet.IP.String()
		}
	}
	return ""
}

func proxyPort(ip, port string) {
	// Listen on the NIC only. 0.0.0.0 would also own 127.0.0.1 and the
	// forwarder would connect to itself.
	ln, err := net.Listen("tcp", net.JoinHostPort(ip, port))
	if err != nil {
		log.Printf("proxy %s: %v", port, err)
		return
	}
	for {
		client, err := ln.Accept()
		if err != nil {
			log.Printf("proxy %s: %v", port, err)
			return
		}
		go forward(client, port)
	}
}

func forward(client net.Conn, port string) {
	defer client.Close()
	upstream, err := net.Dial("tcp", "127.0.0.1:"+port)
	if err != nil {
		return
	}
	defer upstream.Close()
	done := make(chan struct{}, 2)
	go func() {
		_, _ = io.Copy(upstream, client)
		done <- struct{}{}
	}()
	go func() {
		_, _ = io.Copy(client, upstream)
		done <- struct{}{}
	}()
	<-done
}
