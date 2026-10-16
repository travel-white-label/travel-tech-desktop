// hub-runner gives supplier-hub what it expects from a server without changing
// supplier-hub itself: a Redis (miniredis, in memory, on the loopback port in
// REDIS_PORT) and a supervisor that stops it when the desktop launcher goes.
//
// The launcher (main.js) starts this with supplier-hub's whole environment;
// HUB_BIN is the supplier-hub binary, DESKTOP_PARENT_PID the launcher's pid.
// A child process does not die with its parent on Windows, so the parent pid
// is polled and supplier-hub is killed as soon as it disappears.
package main

import (
	"log"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"strconv"
	"syscall"
	"time"

	"github.com/alicebob/miniredis/v2"
)

func main() {
	log.SetPrefix("[hub-runner] ")

	redis := miniredis.NewMiniRedis()
	if err := redis.StartAddr("127.0.0.1:" + os.Getenv("REDIS_PORT")); err != nil {
		log.Fatalf("redis: %v", err)
	}
	defer redis.Close()

	hub := exec.Command(os.Getenv("HUB_BIN"))
	hub.Stdout, hub.Stderr = os.Stdout, os.Stderr
	if err := hub.Start(); err != nil {
		log.Fatalf("start supplier-hub: %v", err)
	}
	exited := make(chan error, 1)
	go func() { exited <- hub.Wait() }()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	parent, _ := strconv.Atoi(os.Getenv("DESKTOP_PARENT_PID"))
	tick := time.NewTicker(3 * time.Second)

	for {
		select {
		case err := <-exited:
			log.Printf("supplier-hub exited: %v", err)
			redis.Close()
			os.Exit(1)
		case <-stop:
			shutdown(hub, exited)
		case <-tick.C:
			if parent > 0 && !alive(parent) {
				log.Printf("launcher pid %d is gone", parent)
				shutdown(hub, exited)
			}
		}
	}
}

func shutdown(hub *exec.Cmd, exited <-chan error) {
	_ = hub.Process.Kill()
	<-exited
	os.Exit(0)
}

// alive reports whether pid still runs. FindProcess opens a handle on Windows
// and fails for a gone pid; elsewhere it always succeeds, so signal 0 checks.
func alive(pid int) bool {
	p, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	defer p.Release()
	if runtime.GOOS == "windows" {
		return true
	}
	return p.Signal(syscall.Signal(0)) == nil
}
