from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.db.models import User
from app.services.security import decode_token

bearer_scheme = HTTPBearer(auto_error=False)
ACCOUNT_DISABLED_MESSAGE = "账户已被停用，请联系平台运营人员"


def _http_error(status_code: int, code: str, message: str) -> HTTPException:
    # detail 用 dict，让 main.py 能透传 code/message 到 ApiResponse.error
    return HTTPException(status_code=status_code, detail={"code": code, "message": message})


def get_current_user(
    creds: HTTPAuthorizationCredentials = Depends(bearer_scheme),
    db: Session = Depends(get_db),
) -> User:
    if not creds or not creds.credentials:
        raise _http_error(
            status_code=status.HTTP_401_UNAUTHORIZED,
            code="MISSING_TOKEN",
            message="Missing token",
        )

    token = creds.credentials
    try:
        data = decode_token(token)
    except Exception:
        raise _http_error(
            status_code=status.HTTP_401_UNAUTHORIZED,
            code="INVALID_TOKEN",
            message="Invalid token",
        )

    if data.get("typ") != "access":
        raise _http_error(
            status_code=status.HTTP_401_UNAUTHORIZED,
            code="INVALID_TOKEN_TYPE",
            message="Invalid token type",
        )

    sub = data.get("sub")
    if not sub:
        raise _http_error(
            status_code=status.HTTP_401_UNAUTHORIZED,
            code="INVALID_TOKEN_PAYLOAD",
            message="Invalid token payload",
        )

    try:
        user_id = int(sub)
    except Exception:
        raise _http_error(
            status_code=status.HTTP_401_UNAUTHORIZED,
            code="INVALID_TOKEN_SUB",
            message="Invalid token subject",
        )

    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise _http_error(
            status_code=status.HTTP_401_UNAUTHORIZED,
            code="USER_NOT_FOUND",
            message="User not found",
        )

    if getattr(user, "status", 1) != 1:
        raise _http_error(
            status_code=status.HTTP_403_FORBIDDEN,
            code="USER_DISABLED",
            message=ACCOUNT_DISABLED_MESSAGE,
        )

    return user
