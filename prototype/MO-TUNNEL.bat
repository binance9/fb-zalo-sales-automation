@echo off
rem ============================================================
rem MO-TUNNEL.bat — Mo duong cong cong (cloudflared) cho webhook
rem Facebook/Zalo goi ve may. Cua so den hien URL dang
rem https://xxxx.trycloudflare.com — copy URL do de cau hinh Meta.
rem Moi lan mo la 1 URL moi (tunnel nhanh) — lam buoc nay SANG mai
rem ngay truoc khi test, sau do cau hinh webhook tren Meta App.
rem ============================================================
start "TunnelBotBanHang" cmd /k ""C:\Program Files (x86)\cloudflared\cloudflared" tunnel --url http://localhost:8080"
timeout /t 6 /nobreak >nul
echo.
echo Da mo tunnel. Xem cua so den "TunnelBotBanHang" de lay URL https://xxxx.trycloudflare.com
echo Webhook Meta dieu huong: https://<URL-vua-lay>/webhooks/meta
