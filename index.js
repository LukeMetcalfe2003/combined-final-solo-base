const express = require('express');
const expressWs = require('express-ws');
const path = require('path');
const mongoose = require('mongoose');
const session = require('express-session');
const bcrypt = require('bcrypt');
const { type } = require('os');
const { request } = require('http');

const PORT = 3000;
//TODO: Update this URI to match your own MongoDB setup
const MONGO_URI = 'mongodb+srv://lukemetcalfe:8dogstrong@cluster0.qp8xr.mongodb.net/';
const app = express();
expressWs(app);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');
app.use(session({
    secret: 'voting-app-secret',
    resave: false,
    saveUninitialized: false,
}));
let connectedClients = [];

// Mongoose 
const userSchema = new mongoose.Schema({
    username: { type: String, required: true },
    password: { type: String, required: true },
    participatedPolls: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Poll' }] // Track participated polls
});

const User = mongoose.model('User', userSchema);

// connect to mongoose
mongoose
  .connect(MONGO_URI)
  .then(() => console.log("Connected to MongoDB"))
  .catch((err) => console.error("Error connecting to MongoDB:", err));

const pollSchema = new mongoose.Schema({
    question: { type: String, required: true },
    options: [
        {
            answer: { type: String, required: true },
            votes: { type: Number, default: 0 },
        },
    ],
});

const Poll = mongoose.model('Poll', pollSchema);


//Note: Not all routes you need are present here, some are missing and you'll need to add them yourself.

app.ws('/ws', (socket, request) => {
    connectedClients.push(socket);

    socket.on('message', async (message) => {
        const data = JSON.parse(message);
        if (data.type === 'vote') {
            await onNewVote(data.pollId, data.selectedOption);
        }
        
    });

    socket.on('close', async (message) => {
        connectedClients = connectedClients.filter((client) => client !== socket);
    });
});

app.get('/', async (request, response) => {
    if (request.session.user?.id) {
        return response.redirect('/dashboard');
    }
    return response.render('index/unauthenticatedIndex', {});
});

app.get('/login', async (request, response) => {
    if (request.session.user?.id){
        return response.redirect('/dashboard');
    }

    response.render('login', {errorMessage: null});
});

app.post('/login', async (request, response) => {
    const { username, password } = request.body;
    const user = await User.findOne({ username });

    if (user && (await bcrypt.compare(password, user.password))) {
        request.session.user = { id: user.id, username: user.username };

        // Fetch the number of polls the user has participated in
        const voteCount = user.participatedPolls.length;

        return response.redirect('/profile');
    }

    return response.render('login', { errorMessage: 'Invalid username or password' });
});

app.get('/signup', async (request, response) => {
    if (request.session.user?.id) {
        return response.redirect('/dashboard');
    }

    return response.render('signup', { errorMessage: null });
});

app.post('/signup', async (request, response) => {
    const { username, password } = request.body;

    try {
        if(!username || !password){
            return response.render('signup', { errorMessage: 'Please fill out all fields' });
        }

        const activeUser = await User.findOne({ username });
        if (activeUser) {
            return response.render('signup', { errorMessage: 'Username already exists' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const createUser = new User({ username, password: hashedPassword });
        await createUser.save();

        request.session.user = { id: createUser.id, username: createUser.username };
        return response.redirect('/dashboard');
    } catch (error) {
        console.error(error);
        return response.render('signup', { errorMessage: 'Error creating user' });
    }

});

app.get('/logout', async (request, response) =>{
    request.session.destroy(() => {
        response.redirect('/');
    });
});

app.get('/dashboard', async (request, response) => {
    if (!request.session.user?.id) {
        return response.redirect('/');
    }

    try {
        const polls = await Poll.find(); // Fetch all polls from the database
        const totalPolls = polls.length;

        return response.render('index/authenticatedIndex', { polls, totalPolls });
    } catch (error) {
        console.error('Error fetching polls:', error);
        return response.status(500).send('Internal Server Error');
    }
});

app.get('/profile', async (request, response) => {
    if (!request.session.user?.id) {
        return response.redirect('/');
    }

    try {
        const user = await User.findById(request.session.user.id).populate('participatedPolls');
        const voteCount = user.participatedPolls.length;

        return response.render('profile', { username: user.username, voteCount });
    } catch (error) {
        console.error('Error fetching profile data:', error);
        return response.status(500).send('Internal Server Error');
    }
});

app.get('/createPoll', async (request, response) => {
    if (!request.session.user?.id) {
        return response.redirect('/');
    }

    return response.render('createPoll', { errorMessage: null });
});

// Poll creation
app.post('/createPoll', async (request, response) => {
    const { question, options } = request.body;
    const formattedOptions = Object.values(options).map((option) => ({ answer: option, votes: 0 }));

    const pollCreationError = await onCreateNewPoll(question, formattedOptions);
    if (pollCreationError){
        return response.render('createPoll', { errorMessage: pollCreationError });
    }

    return response.redirect('/dashboard');
});

app.post('/vote', async (request, response) => {
    const { pollId, selectedOption } = request.body;

    try {
        const poll = await Poll.findById(pollId);
        if (!poll){
            return response.status(404).send('Poll not found');
        }

        // update vote count
        const option = poll.options.find((option) => option.answer === selectedOption);
        if (option) {
            option.votes++;
            await poll.save();

            // Add poll to user's participated polls
            const user = await User.findById(request.session.user.id);
            if (!user.participatedPolls.includes(pollId)) {
                user.participatedPolls.push(pollId);
                await user.save();
            }

            connectedClients.forEach((client) => {
                client.send(JSON.stringify({ type: 'vote', pollId, selectedOption, votes: option.votes }));
            });
        }

        return response.redirect('/dashboard');
    } catch (error) {
        console.error("Error processing vote:", error);
        return response.status(500).send('Error processing vote');
    }
})

mongoose.connect(MONGO_URI).then(() => {
    console.log('Connected to MongoDB');
    app.listen(PORT, () => {
        console.log(`Server listening on http://localhost:${PORT}`);
    });
})
.catch((error) => {
    console.error('Error connecting to MongoDB:', error);
});
/**
 * Handles creating a new poll, based on the data provided to the server
 * 
 * @param {string} question The question the poll is asking
 * @param {[answer: string, votes: number]} pollOptions The various answers the poll allows and how many votes each answer should start with
 * @returns {string?} An error message if an error occurs, or null if no error occurs.
 */
async function onCreateNewPoll(question, pollOptions) {
    try {
        // Save the new poll to MongoDB
        const newPoll = new Poll({ question, options: pollOptions });
        await newPoll.save();

        // Tell all connected sockets that a new poll was added
        connectedClients.forEach((client) => {
            client.send(JSON.stringify({ type: 'newPoll', poll: newPoll }));
        });
    }
    catch (error) {
        console.error(error);
        return "Error creating the poll, please try again";
    }

    return null;
}

/**
 * Handles processing a new vote on a poll
 * 
 * This function isn't necessary and should be removed if it's not used, but it's left as a hint to try and help give
 * an idea of how you might want to handle incoming votes
 * 
 * @param {string} pollId The ID of the poll that was voted on
 * @param {string} selectedOption Which option the user voted for
 */
async function onNewVote(pollId, selectedOption) {
    try {
        const poll = await Poll.findById(pollId);
        if (!poll) {
            console.error('Poll not found');
            return;
        }

        const option = poll.options.find((option) => option.answer === selectedOption);
        if (!option) {
            console.error('Option not found');
            return;
        }

        option.votes++;
        await poll.save();

        // updated poll
        const updatedPoll = {
            type: 'vote',
            id: pollId,
            options: poll.options,
        }

        // Notify all connected clients that a new vote was received
        connectedClients.forEach((client) => {
            client.send(JSON.stringify(updatedPoll));
        });
    } catch (error) {
        console.error('Error processing vote:', error);
        express.response.status(500).send('Error processing vote');
    }
}
