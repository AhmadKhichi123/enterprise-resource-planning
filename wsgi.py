"""Entry point for hosting services (PythonAnywhere, gunicorn, etc.)."""
from app import app as application  # noqa: F401

app = application
