
require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'orders.json');

let orders = [];

if (fs.existsSync(DATA_FILE)) {
  try {
    orders = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    console.error('Order file error:', e.message);
    orders = [];
  }
} else {
  fs.writeFileSync(DATA_FILE, '[]');
}

function saveOrders() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(orders, null, 2));
}
const app = express();


const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }
});

const TOKEN = process.env.BOT_TOKEN;
const ADMIN = String(process.env.ADMIN_CHAT_ID || '');
const PORT = process.env.PORT || 3000;
const API = `https://api.telegram.org/bot${TOKEN}`;

if (!TOKEN || !ADMIN) throw new Error('BOT_TOKEN or ADMIN_CHAT_ID missing');

let offset = 0;
let polling = false;

const prices = {
  mlbb: {
    '11 Diamonds':1500,'22 Diamonds':2800,'42 Diamonds':4200,
    '86 Diamonds':6000,'172 Diamonds':13000,'257 Diamonds':18000,
    '343 Diamonds':25000,'429 Diamonds':31500,'515 Diamonds':36000,
    '600 Diamonds':41000,'706 Diamonds':45000,'878 Diamonds':60000,
    '963 Diamonds':65000,'1049 Diamonds':72000,'1135 Diamonds':78000,
    '1412 Diamonds':95000,'2195 Diamonds':150000,'2901 Diamonds':190000,
    '3688 Diamonds':245000,'4394 Diamonds':300000,
    '5532 Diamonds':375000,'9288 Diamonds':600000
  },
  pubg: {
    '60 UC':5000,'120 UC':10000,'325 UC':24000,
    '660 UC':46000,'1800 UC':112000
  }
};

async function telegram(method, body) {
  const isForm = body instanceof FormData;
  const payload = isForm ? body : new URLSearchParams(
    Object.entries(body).map(([k,v]) => [
      k, typeof v === 'object' ? JSON.stringify(v) : String(v)
    ])
  );

  const res = await fetch(`${API}/${method}`, {
    method:'POST',
    body:payload,
    signal:AbortSignal.timeout(60000)
  });

  const data = await res.json();
  if (!data.ok) throw new Error(data.description);
  return data.result;
}

app.use(express.static(__dirname));

app.post('/api/order', upload.single('paymentProof'), async (req,res) => {
  try {
    const {game,gameId,serverId,packageName,customer} = req.body;
    const price = prices[game]?.[packageName];

    if (!price || !gameId || !customer ||
        (game === 'mlbb' && !serverId)) {
      return res.status(400).json({error:'Order information missing'});
    }

    const id = String(
  Math.max(0, ...orders.map(o => Number(o.id) || 0)) + 1
);

const order = {
  id, game, gameId, serverId,
  packageName, customer, price,
  status: 'PENDING',
  createdAt: new Date().toISOString()
};

orders.push(order);
saveOrders();

    const caption =
      `🛒 ZYRO NEW ORDER #${id}\n\n`+
      `Game: ${game}\nGame ID: ${gameId}\n`+
      (game === 'mlbb' ? `Server ID: ${serverId}\n` : '')+
      `Package: ${packageName}\n`+
      `Price: ${price.toLocaleString('en-US')} MMK\n`+
      `Customer: ${customer}\n`+
      `Payment Screenshot: ${req.file ? 'Attached' : 'Not provided'}\n`+
      `Status: PENDING`;

    const buttons = {
      inline_keyboard:[[
        {text:'✅ APPROVE',callback_data:`approve:${id}`},
        {text:'❌ REJECT',callback_data:`reject:${id}`}
      ]]
    };

    if (req.file) {
      const form = new FormData();
      form.append('chat_id',ADMIN);
      form.append('caption',caption);
      form.append('photo',new Blob(
        [req.file.buffer],{type:req.file.mimetype}
      ),req.file.originalname);
      form.append('reply_markup',JSON.stringify(buttons));
      await telegram('sendPhoto',form);
    } else {
      await telegram('sendMessage',{
        chat_id:ADMIN,text:caption,reply_markup:buttons
      });
    }

    res.json({success:true,orderId:id});
  } catch(e) {
    console.error('ORDER ERROR:',e.message);
    res.status(500).json({error:e.message});
  }
});

// Order history API
app.get('/api/orders', (req,res) => {
  res.json([...orders].reverse().slice(0,100));
});

async function poll() {
  if (polling) return;
  polling = true;

  try {
    const result = await telegram('getUpdates',{
      offset,
      timeout:10,
      allowed_updates:['callback_query']
    });

    for (const update of result) {
      offset = update.update_id + 1;
      const q = update.callback_query;
      if (!q) continue;

      try {
        await telegram('answerCallbackQuery',{
          callback_query_id:q.id
        });
      } catch(e) {
        console.error('Callback answer:',e.message);
      }

      if (String(q.from.id) !== ADMIN) continue;

      const [action,id] = (q.data || '').split(':');
      if (!['approve','reject'].includes(action)) continue;

      const order = orders.find(o => o.id === id);
 
     if (!order || order.status !== 'PENDING') continue;

      const status = action === 'approve' ? 'APPROVED' : 'REJECTED';
      order.status = status;
saveOrders();

      try {
        const oldText = q.message.text || q.message.caption || '';
        if (q.message.photo) {
          await telegram('editMessageCaption',{
            chat_id:q.message.chat.id,
            message_id:q.message.message_id,
            caption:oldText+`\n\n${status}`,
            reply_markup:{inline_keyboard:[]}
          });
        } else {
          await telegram('editMessageText',{
            chat_id:q.message.chat.id,
            message_id:q.message.message_id,
            text:oldText+`\n\n${status}`,
            reply_markup:{inline_keyboard:[]}
          });
        }
        console.log(`Order #${id}: ${status}`);
      } catch(e) {
        console.error('Message update:',e.message);
      }
    }
  } catch(e) {
    console.error('Telegram polling:',e.message);
    await new Promise(r=>setTimeout(r,3000));
  }

  polling = false;
  setImmediate(poll);
}

app.listen(PORT,'0.0.0.0',() => {
  console.log(`ZYRO SHOP SERVER RUNNING ON PORT ${PORT}`);
  poll();
});
