const express = require('express');
const app = express();

app.use(express.static('public'));
app.use(express.json());

app.post('/login', (req, res) => {
    res.send("OK");
});

app.post('/register', (req, res) => {
    res.send("User created");
});

app.listen(3000, () => console.log("Server running"));