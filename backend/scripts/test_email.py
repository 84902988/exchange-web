from app.services.email_service import send_verify_code_email

if __name__ == "__main__":
    # 改成你自己能收到的邮箱
    to_email = "martinx0905@gmail.com"
    send_verify_code_email(to_email=to_email, code="889900")
    print("SENT")
