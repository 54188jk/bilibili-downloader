import os
PROJ = r"C:\Users\Administrator\Desktop\agent\bilibili-downloader"
for f in ["_probe.py","_smoke.py","_xref.py","_smoke.log"]:
    p = os.path.join(PROJ, f)
    if os.path.exists(p):
        os.remove(p)
        print("removed", f)
    else:
        print("absent ", f)
