/* WorldClock - a tiny world clock desktop widget for Windows 10/11.
 * Pure Win32 + GDI, no runtime dependencies. Settings live in WorldClock.ini next to the exe.
 * Left-drag to move, right-click for the menu. */
#define _WIN32_WINNT 0x0A00
#ifndef UNICODE
#define UNICODE
#endif
#define _UNICODE
#include <windows.h>
#include <shellapi.h>
#include <wchar.h>
#include <stdio.h>

#define MAX_CLOCKS 16
#define BASE_W 240
#define ROW_H 46
#define PAD 6

typedef struct {
    WCHAR label[64];
    WCHAR tz[128];
    BOOL local, ok;
    DYNAMIC_TIME_ZONE_INFORMATION dtz;
} Clock;

static Clock g_clk[MAX_CLOCKS];
static int g_n;
static WCHAR g_ini[MAX_PATH], g_exe[MAX_PATH];
static FILETIME g_iniTime;
static BOOL g_top = TRUE, g_secs = FALSE, g_24 = TRUE;
static int g_alpha = 235;
static UINT g_dpi = 96;
static HFONT g_fTime, g_fLabel, g_fSmall;
static HWND g_wnd;
static DWORD g_watchUntil; /* fast ini polling while the user edits it */

enum { ID_TOP = 1, ID_SECS, ID_24, ID_STARTUP, ID_EDIT, ID_RELOAD, ID_EXIT,
       ID_OP100 = 100, ID_OP90, ID_OP80, ID_OP70, ID_OP60 };

#define S(x) MulDiv((x), (int)g_dpi, 96)
static const WCHAR *RUNKEY = L"Software\\Microsoft\\Windows\\CurrentVersion\\Run";

static const char DEFAULT_INI[] =
    "; WorldClock settings\r\n"
    ";\r\n"
    "; Clocks: ClockN=Label,Windows time zone ID   (N = 1..16, shown in order)\r\n"
    "; Leave the ID empty for your PC's local time.\r\n"
    "; To list every valid ID, open a command prompt and run:  tzutil /l\r\n"
    "; (use the ID line, e.g. \"Eastern Standard Time\", not the (UTC..) display line)\r\n"
    "; Save this file - the widget reloads it automatically.\r\n"
    "\r\n"
    "[Clocks]\r\n"
    "Clock1=Local,\r\n"
    "Clock2=New York,Eastern Standard Time\r\n"
    "Clock3=London,GMT Standard Time\r\n"
    "Clock4=Paris,Romance Standard Time\r\n"
    "Clock5=Dubai,Arabian Standard Time\r\n"
    "Clock6=Tokyo,Tokyo Standard Time\r\n"
    "Clock7=Sydney,AUS Eastern Standard Time\r\n"
    "\r\n"
    "[Settings]\r\n"
    "TopMost=1\r\n"
    "Seconds=0\r\n"
    "Hour24=1\r\n"
    "Opacity=235\r\n";

/* ---------- config ---------- */

static void IniTime(FILETIME *ft) {
    WIN32_FILE_ATTRIBUTE_DATA a;
    if (GetFileAttributesExW(g_ini, GetFileExInfoStandard, &a)) *ft = a.ftLastWriteTime;
    else ZeroMemory(ft, sizeof *ft);
}

static void Trim(WCHAR *s) {
    WCHAR *p = s; while (*p == L' ' || *p == L'\t') p++;
    if (p != s) memmove(s, p, (wcslen(p) + 1) * sizeof(WCHAR));
    size_t n = wcslen(s); while (n && (s[n-1] == L' ' || s[n-1] == L'\t')) s[--n] = 0;
}

static BOOL FindTz(const WCHAR *key, DYNAMIC_TIME_ZONE_INFORMATION *out) {
    DYNAMIC_TIME_ZONE_INFORMATION d;
    for (DWORD i = 0; EnumDynamicTimeZoneInformation(i, &d) == ERROR_SUCCESS; i++)
        if (!_wcsicmp(d.TimeZoneKeyName, key)) { *out = d; return TRUE; }
    return FALSE;
}

static void LoadConfig(void) {
    if (GetFileAttributesW(g_ini) == INVALID_FILE_ATTRIBUTES) {
        HANDLE f = CreateFileW(g_ini, GENERIC_WRITE, 0, NULL, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, NULL);
        if (f != INVALID_HANDLE_VALUE) {
            /* write as UTF-16LE with BOM so the profile API keeps it Unicode */
            WCHAR buf[sizeof DEFAULT_INI + 1]; DWORD w;
            int n = MultiByteToWideChar(CP_UTF8, 0, DEFAULT_INI, -1, buf + 1, sizeof DEFAULT_INI);
            buf[0] = 0xFEFF;
            WriteFile(f, buf, (DWORD)n * sizeof(WCHAR), &w, NULL); /* BOM + text, no NUL */
            CloseHandle(f);
        }
    }
    g_top   = GetPrivateProfileIntW(L"Settings", L"TopMost", 1, g_ini) != 0;
    g_secs  = GetPrivateProfileIntW(L"Settings", L"Seconds", 0, g_ini) != 0;
    g_24    = GetPrivateProfileIntW(L"Settings", L"Hour24", 1, g_ini) != 0;
    g_alpha = GetPrivateProfileIntW(L"Settings", L"Opacity", 235, g_ini);
    if (g_alpha < 60) g_alpha = 60;
    if (g_alpha > 255) g_alpha = 255;

    g_n = 0;
    for (int i = 1; i <= MAX_CLOCKS; i++) {
        WCHAR k[16], v[256];
        swprintf(k, 16, L"Clock%d", i);
        if (!GetPrivateProfileStringW(L"Clocks", k, L"", v, 256, g_ini)) continue;
        Clock *c = &g_clk[g_n];
        ZeroMemory(c, sizeof *c);
        WCHAR *comma = wcschr(v, L',');
        if (comma) { *comma = 0; lstrcpynW(c->tz, comma + 1, 128); }
        lstrcpynW(c->label, v, 64);
        Trim(c->label); Trim(c->tz);
        if (!c->label[0]) continue;
        if (!c->tz[0]) c->local = c->ok = TRUE;
        else c->ok = FindTz(c->tz, &c->dtz);
        g_n++;
    }
    if (!g_n) { lstrcpyW(g_clk[0].label, L"Local"); g_clk[0].local = g_clk[0].ok = TRUE; g_n = 1; }
    IniTime(&g_iniTime);
}

static void SaveInt(const WCHAR *k, int v) {
    WCHAR b[16]; swprintf(b, 16, L"%d", v);
    WritePrivateProfileStringW(L"Settings", k, b, g_ini);
    IniTime(&g_iniTime);
}

static BOOL StartupEnabled(void) {
    HKEY k; BOOL r = FALSE;
    if (RegOpenKeyExW(HKEY_CURRENT_USER, RUNKEY, 0, KEY_READ, &k) == ERROR_SUCCESS) {
        r = RegQueryValueExW(k, L"WorldClock", NULL, NULL, NULL, NULL) == ERROR_SUCCESS;
        RegCloseKey(k);
    }
    return r;
}

static void SetStartup(BOOL on) {
    HKEY k;
    if (RegOpenKeyExW(HKEY_CURRENT_USER, RUNKEY, 0, KEY_SET_VALUE, &k) != ERROR_SUCCESS) return;
    if (on) {
        WCHAR v[MAX_PATH + 4]; swprintf(v, MAX_PATH + 4, L"\"%ls\"", g_exe);
        RegSetValueExW(k, L"WorldClock", 0, REG_SZ, (BYTE *)v, (DWORD)(wcslen(v) + 1) * sizeof(WCHAR));
    } else RegDeleteValueW(k, L"WorldClock");
    RegCloseKey(k);
}

/* ---------- layout / drawing ---------- */

static HFONT MkFont(int px, int weight) {
    return CreateFontW(-S(px), 0, 0, 0, weight, 0, 0, 0, DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                       CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, DEFAULT_PITCH, L"Segoe UI");
}

static void MakeFonts(void) {
    if (g_fTime) { DeleteObject(g_fTime); DeleteObject(g_fLabel); DeleteObject(g_fSmall); }
    g_fTime = MkFont(24, FW_SEMIBOLD);
    g_fLabel = MkFont(15, FW_SEMIBOLD);
    g_fSmall = MkFont(12, FW_NORMAL);
}

static void Relayout(void) {
    int w = S(BASE_W), h = S(PAD) * 2 + g_n * S(ROW_H);
    SetWindowPos(g_wnd, NULL, 0, 0, w, h, SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);
    SetWindowRgn(g_wnd, CreateRoundRectRgn(0, 0, w + 1, h + 1, S(16), S(16)), TRUE);
    SetLayeredWindowAttributes(g_wnd, 0, (BYTE)g_alpha, LWA_ALPHA);
    InvalidateRect(g_wnd, NULL, FALSE);
}

static ULONGLONG Minutes(const SYSTEMTIME *st) {
    FILETIME ft; SystemTimeToFileTime(st, &ft);
    return (((ULONGLONG)ft.dwHighDateTime << 32) | ft.dwLowDateTime) / 600000000ULL;
}

static void Paint(HDC hdc, RECT rc) {
    HBRUSH bg = CreateSolidBrush(RGB(22, 24, 29));
    FillRect(hdc, &rc, bg); DeleteObject(bg);
    SetBkMode(hdc, TRANSPARENT);

    SYSTEMTIME utc, loc;
    GetSystemTime(&utc);
    SystemTimeToTzSpecificLocalTime(NULL, &utc, &loc);
    LONGLONG locMin = (LONGLONG)Minutes(&loc);

    HPEN sep = CreatePen(PS_SOLID, 1, RGB(42, 45, 53));
    HGDIOBJ oldPen = SelectObject(hdc, sep);

    for (int i = 0; i < g_n; i++) {
        Clock *c = &g_clk[i];
        int top = S(PAD) + i * S(ROW_H);
        RECT row = { S(14), top, rc.right - S(14), top + S(ROW_H) };
        if (i) { MoveToEx(hdc, S(12), top, NULL); LineTo(hdc, rc.right - S(12), top); }

        SYSTEMTIME t = loc;
        if (!c->local && c->ok) SystemTimeToTzSpecificLocalTimeEx(&c->dtz, &utc, &t);

        WCHAR time[32], sub[96], date[48];
        if (!c->ok) { lstrcpyW(time, L"--:--"); lstrcpyW(sub, L"unknown time zone ID"); }
        else {
            int h = t.wHour;
            if (g_24) swprintf(time, 32, g_secs ? L"%02d:%02d:%02d" : L"%02d:%02d", h, t.wMinute, t.wSecond);
            else {
                int h12 = h % 12 ? h % 12 : 12;
                const WCHAR *ap = h < 12 ? L"AM" : L"PM";
                if (g_secs) swprintf(time, 32, L"%d:%02d:%02d %ls", h12, t.wMinute, t.wSecond, ap);
                else        swprintf(time, 32, L"%d:%02d %ls", h12, t.wMinute, ap);
            }
            GetDateFormatEx(LOCALE_NAME_USER_DEFAULT, 0, &t, L"ddd d MMM", date, 48, NULL);
            LONGLONG diff = (LONGLONG)Minutes(&t) - locMin;
            if (c->local || diff == 0) lstrcpynW(sub, date, 96);
            else {
                LONGLONG a = diff < 0 ? -diff : diff;
                if (a % 60) swprintf(sub, 96, L"%ls  \x00B7  %lc%lld:%02lldh", date, diff < 0 ? L'-' : L'+', a / 60, a % 60);
                else        swprintf(sub, 96, L"%ls  \x00B7  %lc%lldh", date, diff < 0 ? L'-' : L'+', a / 60);
            }
        }
        BOOL night = c->ok && (t.wHour < 7 || t.wHour >= 20);

        RECT r = row; r.top += S(6);
        SelectObject(hdc, g_fLabel);
        SetTextColor(hdc, RGB(236, 238, 242));
        DrawTextW(hdc, c->label, -1, &r, DT_LEFT | DT_TOP | DT_SINGLELINE | DT_END_ELLIPSIS | DT_NOPREFIX);

        r = row; r.top += S(25);
        SelectObject(hdc, g_fSmall);
        SetTextColor(hdc, c->ok ? RGB(128, 134, 148) : RGB(230, 110, 100));
        DrawTextW(hdc, sub, -1, &r, DT_LEFT | DT_TOP | DT_SINGLELINE | DT_NOPREFIX);

        r = row;
        SelectObject(hdc, g_fTime);
        SetTextColor(hdc, night ? RGB(120, 150, 215) : RGB(255, 255, 255));
        DrawTextW(hdc, time, -1, &r, DT_RIGHT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
    }
    SelectObject(hdc, oldPen); DeleteObject(sep);
}

static void Schedule(void) {
    SYSTEMTIME st; GetSystemTime(&st);
    UINT ms = g_secs ? 1000u - st.wMilliseconds : (60u - st.wSecond) * 1000u - st.wMilliseconds;
    SetTimer(g_wnd, 1, ms + 20, NULL);
}

static void ShowMenu(HWND h, int x, int y) {
    HMENU m = CreatePopupMenu(), op = CreatePopupMenu();
    static const int ops[] = { 255, 230, 205, 180, 155 };
    static const WCHAR *opn[] = { L"100%", L"90%", L"80%", L"70%", L"60%" };
    for (int i = 0; i < 5; i++) {
        BOOL cur = g_alpha >= ops[i] - 12 && g_alpha <= ops[i] + 12;
        AppendMenuW(op, MF_STRING | (cur ? MF_CHECKED : 0), ID_OP100 + i, opn[i]);
    }
    AppendMenuW(m, MF_STRING | (g_top ? MF_CHECKED : 0), ID_TOP, L"Always on top");
    AppendMenuW(m, MF_STRING | (g_secs ? MF_CHECKED : 0), ID_SECS, L"Show seconds");
    AppendMenuW(m, MF_STRING | (g_24 ? MF_CHECKED : 0), ID_24, L"24-hour clock");
    AppendMenuW(m, MF_POPUP, (UINT_PTR)op, L"Opacity");
    AppendMenuW(m, MF_SEPARATOR, 0, NULL);
    AppendMenuW(m, MF_STRING, ID_EDIT, L"Edit cities...");
    AppendMenuW(m, MF_STRING, ID_RELOAD, L"Reload");
    AppendMenuW(m, MF_STRING | (StartupEnabled() ? MF_CHECKED : 0), ID_STARTUP, L"Start with Windows");
    AppendMenuW(m, MF_SEPARATOR, 0, NULL);
    AppendMenuW(m, MF_STRING, ID_EXIT, L"Exit");
    SetForegroundWindow(h);
    int cmd = TrackPopupMenu(m, TPM_RETURNCMD | TPM_RIGHTBUTTON, x, y, 0, h, NULL);
    DestroyMenu(m);
    switch (cmd) {
    case ID_TOP: g_top = !g_top; SaveInt(L"TopMost", g_top);
        SetWindowPos(h, g_top ? HWND_TOPMOST : HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE); break;
    case ID_SECS: g_secs = !g_secs; SaveInt(L"Seconds", g_secs); InvalidateRect(h, NULL, FALSE); Schedule(); break;
    case ID_24: g_24 = !g_24; SaveInt(L"Hour24", g_24); InvalidateRect(h, NULL, FALSE); break;
    case ID_STARTUP: SetStartup(!StartupEnabled()); break;
    case ID_EDIT:
        ShellExecuteW(NULL, L"open", L"notepad.exe", g_ini, NULL, SW_SHOWNORMAL);
        g_watchUntil = GetTickCount() + 15 * 60 * 1000;
        SetTimer(h, 2, 1500, NULL);
        break;
    case ID_RELOAD: LoadConfig(); Relayout(); Schedule(); break;
    case ID_EXIT: DestroyWindow(h); break;
    default:
        if (cmd >= ID_OP100 && cmd <= ID_OP60) {
            g_alpha = ops[cmd - ID_OP100]; SaveInt(L"Opacity", g_alpha);
            SetLayeredWindowAttributes(h, 0, (BYTE)g_alpha, LWA_ALPHA);
        }
    }
}

static void SavePos(void) {
    RECT r; GetWindowRect(g_wnd, &r);
    SaveInt(L"X", r.left); SaveInt(L"Y", r.top);
}

static LRESULT CALLBACK WndProc(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
    case WM_PAINT: {
        PAINTSTRUCT ps; HDC hdc = BeginPaint(h, &ps);
        RECT rc; GetClientRect(h, &rc);
        HDC mem = CreateCompatibleDC(hdc);
        HBITMAP bmp = CreateCompatibleBitmap(hdc, rc.right, rc.bottom);
        HGDIOBJ ob = SelectObject(mem, bmp);
        Paint(mem, rc);
        BitBlt(hdc, 0, 0, rc.right, rc.bottom, mem, 0, 0, SRCCOPY);
        SelectObject(mem, ob); DeleteObject(bmp); DeleteDC(mem);
        EndPaint(h, &ps);
        return 0;
    }
    case WM_ERASEBKGND: return 1;
    case WM_TIMER: {
        if (wp == 2 && (LONG)(GetTickCount() - g_watchUntil) > 0) KillTimer(h, 2);
        FILETIME ft; IniTime(&ft);
        if (CompareFileTime(&ft, &g_iniTime)) { LoadConfig(); Relayout();
            SetWindowPos(h, g_top ? HWND_TOPMOST : HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE); }
        if (wp == 1) { InvalidateRect(h, NULL, FALSE); Schedule(); }
        return 0;
    }
    case WM_TIMECHANGE:
    case WM_SETTINGCHANGE:
    case WM_POWERBROADCAST:
        InvalidateRect(h, NULL, FALSE); Schedule(); break;
    case WM_LBUTTONDOWN:
        ReleaseCapture();
        SendMessageW(h, WM_NCLBUTTONDOWN, HTCAPTION, 0);
        return 0;
    case WM_EXITSIZEMOVE: SavePos(); return 0;
    case WM_RBUTTONUP: {
        POINT p = { (short)LOWORD(lp), (short)HIWORD(lp) };
        ClientToScreen(h, &p); ShowMenu(h, p.x, p.y);
        return 0;
    }
    case WM_DPICHANGED: {
        g_dpi = HIWORD(wp);
        RECT *r = (RECT *)lp;
        SetWindowPos(h, NULL, r->left, r->top, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
        MakeFonts(); Relayout();
        return 0;
    }
    case WM_DESTROY: KillTimer(h, 1); KillTimer(h, 2); PostQuitMessage(0); return 0;
    }
    return DefWindowProcW(h, msg, wp, lp);
}

int WINAPI wWinMain(HINSTANCE inst, HINSTANCE prev, PWSTR cmd, int show) {
    (void)prev; (void)cmd; (void)show;
    HANDLE mtx = CreateMutexW(NULL, TRUE, L"Local\\WorldClockWidget");
    if (GetLastError() == ERROR_ALREADY_EXISTS) return 0;

    GetModuleFileNameW(NULL, g_exe, MAX_PATH);
    lstrcpyW(g_ini, g_exe);
    WCHAR *dot = wcsrchr(g_ini, L'.'); if (dot) *dot = 0;
    lstrcatW(g_ini, L".ini");
    LoadConfig();

    WNDCLASSW wc = { 0 };
    wc.lpfnWndProc = WndProc;
    wc.hInstance = inst;
    wc.hCursor = LoadCursor(NULL, IDC_ARROW);
    wc.hIcon = LoadIconW(inst, MAKEINTRESOURCEW(1));
    wc.lpszClassName = L"WorldClockWidget";
    RegisterClassW(&wc);

    g_wnd = CreateWindowExW(WS_EX_TOOLWINDOW | WS_EX_LAYERED | (g_top ? WS_EX_TOPMOST : 0),
                            wc.lpszClassName, L"World Clock", WS_POPUP,
                            0, 0, 10, 10, NULL, NULL, inst, NULL);
    g_dpi = GetDpiForWindow(g_wnd);
    if (!g_dpi) g_dpi = 96;
    MakeFonts();
    Relayout();

    RECT wr; GetWindowRect(g_wnd, &wr);
    int w = wr.right - wr.left;
    WCHAR sx[16], sy[16];
    GetPrivateProfileStringW(L"Settings", L"X", L"", sx, 16, g_ini);
    GetPrivateProfileStringW(L"Settings", L"Y", L"", sy, 16, g_ini);
    int x = sx[0] ? _wtoi(sx) : INT_MIN, y = sy[0] ? _wtoi(sy) : INT_MIN;
    POINT pt = { x + S(20), y + S(20) };
    if (x == INT_MIN || y == INT_MIN || !MonitorFromPoint(pt, MONITOR_DEFAULTTONULL)) {
        RECT work; SystemParametersInfoW(SPI_GETWORKAREA, 0, &work, 0);
        x = work.right - w - S(24); y = work.top + S(24);
    }
    SetWindowPos(g_wnd, NULL, x, y, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
    ShowWindow(g_wnd, SW_SHOWNOACTIVATE);
    UpdateWindow(g_wnd);
    Schedule();
    SetProcessWorkingSetSize(GetCurrentProcess(), (SIZE_T)-1, (SIZE_T)-1);

    MSG m;
    while (GetMessageW(&m, NULL, 0, 0) > 0) { TranslateMessage(&m); DispatchMessageW(&m); }
    if (mtx) CloseHandle(mtx);
    return 0;
}
