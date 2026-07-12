package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	loginURL           = "https://www.douyin.com/user/self?showTab=favorite_collection"
	defaultSettingsURL = "http://localhost:3000/settings"
	loginTimeout       = 5 * time.Minute
)

var loginCookieNames = map[string]struct{}{
	"sessionid": {}, "sessionid_ss": {}, "sid_guard": {}, "sid_tt": {},
}

func main() {
	probe := len(os.Args) > 1 && os.Args[1] == "--probe"
	if err := run(probe); err != nil {
		message := "获取失败：" + err.Error()
		fmt.Fprintln(os.Stderr, message)
		showPlatformError(message, probe)
		os.Exit(1)
	}
}

func run(probe bool) error {
	browserPath, err := findBrowser()
	if err != nil {
		return err
	}
	profileDir, err := os.MkdirTemp("", "echolens-douyin-credential-")
	if err != nil {
		return fmt.Errorf("创建临时浏览器目录失败: %w", err)
	}
	cleanupPending := true
	defer func() {
		if cleanupPending {
			_ = removeTemporaryDirectory(profileDir)
		}
	}()

	port, err := freePort()
	if err != nil {
		return err
	}
	browser, err := startBrowser(browserPath, profileDir, port, probe)
	if err != nil {
		return err
	}
	defer browser.stop(nil)

	if probe {
		fmt.Println("正在检查浏览器连接...")
	} else {
		fmt.Println("已打开独立浏览器窗口，请完成抖音登录。")
	}
	websocketURL, err := waitForPageWebSocket(port, browser, 20*time.Second)
	if err != nil {
		return err
	}
	client, err := newCDPClient(websocketURL)
	if err != nil {
		return fmt.Errorf("连接浏览器失败: %w", err)
	}
	defer client.close()

	if probe {
		if _, err := readDouyinCookies(client); err != nil {
			return err
		}
		browser.stop(client)
		if err := removeTemporaryDirectory(profileDir); err != nil {
			return err
		}
		cleanupPending = false
		fmt.Println("READY")
		return nil
	}

	cookies, err := waitForLoginCookies(client, browser, loginTimeout)
	if err != nil {
		return err
	}
	parts := make([]string, 0, len(cookies))
	for _, cookie := range cookies {
		parts = append(parts, cookie.Name+"="+cookie.Value)
	}
	credential := strings.Join(parts, "; ")
	if credential == "" {
		return errors.New("没有读取到可用凭证")
	}
	if err := copyToClipboard(credential); err != nil {
		return err
	}

	fmt.Println("登录状态已确认，凭证已复制到剪贴板。")
	fmt.Println("正在关闭临时浏览器并返回 EchoLens 设置页...")
	browser.stop(client)
	if err := removeTemporaryDirectory(profileDir); err != nil {
		return err
	}
	cleanupPending = false
	return openSettingsPage()
}

func findBrowser() (string, error) {
	if explicit := firstNonEmpty(os.Getenv("CHROME_PATH"), os.Getenv("BROWSER_PATH")); explicit != "" {
		if fileExists(explicit) {
			return explicit, nil
		}
	}

	var candidates []string
	switch runtime.GOOS {
	case "windows":
		candidates = []string{
			filepath.Join(os.Getenv("ProgramFiles"), "Google", "Chrome", "Application", "chrome.exe"),
			filepath.Join(os.Getenv("ProgramFiles(x86)"), "Google", "Chrome", "Application", "chrome.exe"),
			filepath.Join(os.Getenv("LOCALAPPDATA"), "Google", "Chrome", "Application", "chrome.exe"),
			filepath.Join(os.Getenv("ProgramFiles"), "Microsoft", "Edge", "Application", "msedge.exe"),
			filepath.Join(os.Getenv("ProgramFiles(x86)"), "Microsoft", "Edge", "Application", "msedge.exe"),
		}
	case "darwin":
		home, _ := os.UserHomeDir()
		candidates = []string{
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			filepath.Join(home, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
			"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
			filepath.Join(home, "Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
		}
	default:
		return "", errors.New("当前系统不支持自动获取，请使用开发者工具方式")
	}
	for _, candidate := range candidates {
		if candidate != "" && fileExists(candidate) {
			return candidate, nil
		}
	}
	return "", errors.New("未找到 Chrome 或 Edge，请安装浏览器后重试")
}

func startBrowser(path, profileDir string, port int, headless bool) (*browserProcess, error) {
	args := []string{
		fmt.Sprintf("--remote-debugging-port=%d", port),
		"--remote-allow-origins=*",
		"--user-data-dir=" + profileDir,
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-background-mode",
	}
	if headless {
		args = append(args, "--headless=new")
	}
	args = append(args, loginURL)
	command := exec.Command(path, args...)
	command.Stdout = io.Discard
	command.Stderr = io.Discard
	if err := command.Start(); err != nil {
		return nil, fmt.Errorf("启动浏览器失败: %w", err)
	}
	process := &browserProcess{command: command, done: make(chan struct{})}
	go func() {
		_ = command.Wait()
		close(process.done)
	}()
	return process, nil
}

type browserProcess struct {
	command *exec.Cmd
	done    chan struct{}
	once    sync.Once
}

func (browser *browserProcess) running() bool {
	select {
	case <-browser.done:
		return false
	default:
		return true
	}
}

func (browser *browserProcess) stop(client *cdpClient) {
	browser.once.Do(func() {
		if client != nil {
			_ = client.call("Browser.close", map[string]any{}, nil)
		}
		select {
		case <-browser.done:
		case <-time.After(3 * time.Second):
			forceStopProcess(browser.command)
		}
	})
}

func forceStopProcess(command *exec.Cmd) {
	if command.Process == nil {
		return
	}
	if runtime.GOOS == "windows" {
		_ = exec.Command("taskkill.exe", "/PID", fmt.Sprint(command.Process.Pid), "/T", "/F").Run()
		return
	}
	_ = command.Process.Kill()
}

func freePort() (int, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, fmt.Errorf("分配浏览器端口失败: %w", err)
	}
	defer listener.Close()
	return listener.Addr().(*net.TCPAddr).Port, nil
}

func waitForPageWebSocket(port int, browser *browserProcess, timeout time.Duration) (string, error) {
	client := &http.Client{Timeout: 2 * time.Second}
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if !browser.running() {
			return "", errors.New("浏览器已关闭，请重新运行程序")
		}
		response, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d/json/list", port))
		if err == nil {
			var pages []struct {
				Type      string `json:"type"`
				WebSocket string `json:"webSocketDebuggerUrl"`
			}
			decodeErr := json.NewDecoder(response.Body).Decode(&pages)
			response.Body.Close()
			if decodeErr == nil {
				for _, page := range pages {
					if page.Type == "page" && page.WebSocket != "" {
						return page.WebSocket, nil
					}
				}
			}
		}
		time.Sleep(250 * time.Millisecond)
	}
	return "", errors.New("浏览器调试端口启动超时")
}

type browserCookie struct {
	Domain string `json:"domain"`
	Name   string `json:"name"`
	Value  string `json:"value"`
}

func waitForLoginCookies(client *cdpClient, browser *browserProcess, timeout time.Duration) ([]browserCookie, error) {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if !browser.running() {
			return nil, errors.New("浏览器已关闭，请重新运行程序")
		}
		cookies, err := readDouyinCookies(client)
		if err != nil {
			return nil, err
		}
		if hasLoginCookie(cookies) {
			return cookies, nil
		}
		time.Sleep(time.Second)
	}
	return nil, errors.New("等待登录超时，请重新运行后完成抖音登录")
}

func readDouyinCookies(client *cdpClient) ([]browserCookie, error) {
	var result struct {
		Cookies []browserCookie `json:"cookies"`
	}
	if err := client.call("Storage.getCookies", map[string]any{}, &result); err != nil {
		result.Cookies = nil
		if fallbackErr := client.call("Network.getCookies", map[string]any{
			"urls": []string{"https://www.douyin.com/", loginURL},
		}, &result); fallbackErr != nil {
			return nil, fmt.Errorf("读取浏览器凭证失败: %w", fallbackErr)
		}
	}

	return filterDouyinCookies(result.Cookies), nil
}

func filterDouyinCookies(source []browserCookie) []browserCookie {
	cookies := make([]browserCookie, 0, len(source))
	for _, cookie := range source {
		domain := strings.TrimPrefix(strings.ToLower(cookie.Domain), ".")
		if (domain == "douyin.com" || strings.HasSuffix(domain, ".douyin.com")) && cookie.Name != "" && cookie.Value != "" {
			cookies = append(cookies, cookie)
		}
	}
	sort.Slice(cookies, func(left, right int) bool { return cookies[left].Name < cookies[right].Name })
	return cookies
}

func hasLoginCookie(cookies []browserCookie) bool {
	for _, cookie := range cookies {
		if _, ok := loginCookieNames[strings.ToLower(cookie.Name)]; ok {
			return true
		}
	}
	return false
}

type cdpClient struct {
	connection *websocket.Conn
	nextID     int
}

func newCDPClient(url string) (*cdpClient, error) {
	connection, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		return nil, err
	}
	return &cdpClient{connection: connection}, nil
}

func (client *cdpClient) call(method string, params map[string]any, result any) error {
	client.nextID++
	id := client.nextID
	_ = client.connection.SetWriteDeadline(time.Now().Add(10 * time.Second))
	if err := client.connection.WriteJSON(map[string]any{"id": id, "method": method, "params": params}); err != nil {
		return err
	}

	for {
		_ = client.connection.SetReadDeadline(time.Now().Add(10 * time.Second))
		var response struct {
			ID     int             `json:"id"`
			Result json.RawMessage `json:"result"`
			Error  *struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := client.connection.ReadJSON(&response); err != nil {
			return err
		}
		if response.ID != id {
			continue
		}
		if response.Error != nil {
			return errors.New(response.Error.Message)
		}
		if result == nil || len(response.Result) == 0 {
			return nil
		}
		return json.Unmarshal(response.Result, result)
	}
}

func (client *cdpClient) close() {
	_ = client.connection.Close()
}

func copyToClipboard(value string) error {
	var command *exec.Cmd
	if runtime.GOOS == "windows" {
		command = exec.Command("clip.exe")
	} else {
		command = exec.Command("pbcopy")
	}
	command.Stdin = strings.NewReader(value)
	if err := command.Run(); err != nil {
		return fmt.Errorf("写入剪贴板失败: %w", err)
	}
	return nil
}

func openSettingsPage() error {
	url := firstNonEmpty(os.Getenv("ECHOLENS_SETTINGS_URL"), defaultSettingsURL)
	var command *exec.Cmd
	if runtime.GOOS == "windows" {
		command = exec.Command("rundll32.exe", "url.dll,FileProtocolHandler", url)
	} else {
		command = exec.Command("open", url)
	}
	if err := command.Start(); err != nil {
		return fmt.Errorf("打开 EchoLens 设置页失败: %w", err)
	}
	return nil
}

func showPlatformError(message string, probe bool) {
	if probe {
		return
	}
	if runtime.GOOS == "darwin" {
		_ = exec.Command(
			"osascript",
			"-e", "on run argv",
			"-e", "display alert \"EchoLens 抖音凭证\" message (item 1 of argv) as critical",
			"-e", "end run",
			message,
		).Run()
		return
	}
	fmt.Println("按回车键关闭窗口。")
	_, _ = fmt.Scanln()
}

func removeTemporaryDirectory(path string) error {
	var lastError error
	for attempt := 0; attempt < 5; attempt++ {
		if err := os.RemoveAll(path); err == nil {
			return nil
		} else {
			lastError = err
		}
		time.Sleep(200 * time.Millisecond)
	}
	return fmt.Errorf("清理临时浏览器目录失败: %w", lastError)
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
