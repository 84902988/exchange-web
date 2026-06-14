from datetime import datetime, timedelta
from typing import Any, Dict, Optional

from jose import jwt
from passlib.context import CryptContext

from app.core.config import settings

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 30
REFRESH_TOKEN_EXPIRE_DAYS = 14


def hash_password(password: str) -> str:
    # 可选 pepper（提高抗撞库），没有就不加
    pepper = settings.SECURITY_PEPPER or ""
    return pwd_context.hash(password + pepper)


def verify_password(password: str, password_hash: str) -> bool:
    pepper = settings.SECURITY_PEPPER or ""
    return pwd_context.verify(password + pepper, password_hash)


def create_token(payload: Dict[str, Any], expires_delta: timedelta) -> str:
    to_encode = dict(payload)
    expire = datetime.utcnow() + expires_delta
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, settings.JWT_SECRET, algorithm=ALGORITHM)


def create_access_token(sub: str) -> str:
    return create_token(
        {"sub": sub, "typ": "access"},
        timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES),
    )


def create_refresh_token(sub: str) -> str:
    return create_token(
        {"sub": sub, "typ": "refresh"},
        timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS),
    )


def decode_token(token: str) -> Dict[str, Any]:
    return jwt.decode(token, settings.JWT_SECRET, algorithms=[ALGORITHM])
