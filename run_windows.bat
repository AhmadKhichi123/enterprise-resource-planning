@echo off
REM Runs the shop app on this computer. Phones on the same Wi-Fi can open
REM http://<this-computer's-IP>:5000  (find the IP with the "ipconfig" command).
cd /d "%~dp0"
python -m pip install -q -r requirements.txt
set HOST=0.0.0.0
start "" http://127.0.0.1:5000
python app.py
pause
