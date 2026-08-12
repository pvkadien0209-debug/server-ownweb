const nodemailer = require("nodemailer");

async function sendmailDK(
  subjectText,
  contentText,
  toEmail = "pvkadien0209@gmail.com"
) {
  try {
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: "pvkadien0209@gmail.com",
        pass: "hwkflmwdaivrfajx", // Nên lưu vào biến môi trường để bảo mật
      },
    });

    const mailOptions = {
      from: '"PVD English" <pvkadien0209@gmail.com>',
      to: toEmail,
      subject: subjectText,
      html: `
        <div style="width:500px; text-align:center; border: 1px solid green; border-radius:5px; padding: 10px;">
          <h3>Học kiến thức - Rèn kĩ năng</h3>
          <h2>BUILD CONFIDENCE - OPEN YOUR FUTURE.</h2>
          <hr/>
          <h5>${contentText}</h5>
          <h1>Bạn đã nộp bài thành công!</h1>
        </div>
      `,
    };

    const info = await transporter.sendMail(mailOptions);
    console.log("Email sent:", info.response);
  } catch (error) {
    console.error("Error sending email:", error);
  }
}

module.exports = { sendmailDK };
