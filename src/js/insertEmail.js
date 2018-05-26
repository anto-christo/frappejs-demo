const frappe = require('frappejs');

const senderEl = document.getElementById("sender");
const receiverEl = document.getElementById("receiver");
const subjectEl = document.getElementById("subject");
const messageEl = document.getElementById("message");
const sendBtn = document.getElementById("send");

const sender = senderEl.value;
const receiver = receiverEl.value;
const subject = subjectEl.value || "No Subject";
const message = messageEl.value;

sendBtn.onclick = function(){

    const data = frappe.newDoc({
        doctype: 'Email',
        sender: sender,
        receiver: receiver,
        subject: subject,
        message: message
    });

    data.insert();
}