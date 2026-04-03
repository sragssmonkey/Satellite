import sys
import os

backend_path = r'c:\Users\Jashwitha\OneDrive\Desktop\Satellite\backend'
if backend_path not in sys.path:
    sys.path.append(backend_path)

try:
    from main import app
    print("Success: main.app imported")
except Exception as e:
    import traceback
    traceback.print_exc()
