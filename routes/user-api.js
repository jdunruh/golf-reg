

var express = require('express');
var router = express.Router();
var mongoose = require('mongoose');
var common = require('./common');
var persist = require('../persist');
var csp = require('js-csp');
var ObjectId = mongoose.Schema.Types.ObjectId;
var mailer = require('../mailer');


var events = require('../models/event-model');
var players = require('../models/player-model');


// event - event object, flight - flight index into event.flights array, player - player being changed
var authorizedEventUpdate = function(user, player) {
    return player._id.equals(user._id) || player.addedBy.equals(user._id);
};

// see if arr1 and arr2 have an element in common
var objectIdArrayMatch = function(arr1, arr2) {
    var combined = arr1.concat(arr2);
    combined.sort(); // sorts array in place
    var previousElement = combined[0];
    for(var i = 1; i < combined.length; i++) {
        if(previousElement.equals(combined[i]))
            return true;
        previousElement = combined[i];
    }
    return false;
};


var removePlayerFromFlight = function(flightPlayers, player) {
    return flightPlayers.filter(el => el.name != player.name);
};

var findPlayerInFilght = function(flightPlayers, player) {
    return flightPlayers.find(el => el.name === player.name);
};

var playerInFlight = function(flightPlayers, player) {
    return flightPlayers.some(el => el.name === player.name);
};

var getAllPlayers = function(res) {
    csp.go(function*() {
        var result = yield csp.take(persist.getAll(players.Player));
        if(result instanceof Error)
            res.status(404);
        else {
            res.status(200).json(result);
        }
    })
};


router.get('/getAllEVents', function(req, res, next) {
     csp.go(function* () {
        var userEvents = yield csp.take(persist.findModelByQuery(events.Event, {organizations: {$in: req.user.organizations},
            date: {$gt: new Date()}}));
        if (userEvents instanceof Error) {
            res.status(404).json(err);
        } else {
            var returnEvents = common.convertEventDocumentsToDisplay(userEvents);
            res.status(200).json(returnEvents);
        }
    });
});

router.delete('/removeModel/', function (req, res, next) {
    csp.go(function* () {
        var event = yield csp.take(persist.getModelById(events.Event, req.body.event));
        if (event instanceof Error) {
            res.status(404).json(event);
            return;
        }
        if (!event.flights[req.body.flight]) {
            res.status(500).json({error: "no such flight"});
            return;
        }
        // use .id virtual element to compare hex string to played._id, a hex string coming from JSON
        var player = event.flights[req.body.flight].players.find(el => el.id === req.body.player._id);
        if(!player) {
            res.status(404).json({error: "player not found"});
            return;
        }
        if (!(authorizedEventUpdate(req.user, player))) {
            res.status(500).json({error: "You can only cancel your time or the time of someone you added"});
            return;
        }
         event.flights[req.body.flight].players = removePlayerFromFlight(event.flights[req.body.flight].players, req.body.player);
        var result = yield csp.take(persist.saveModel(event));
        if (result instanceof Error) {
            res.status(500).json(result);
        } else {
            res.status(200).json(result);
        }
    })
});


router.put('/addPlayer/', function(req, res, next) {
    csp.go(function* () {
        var event = yield csp.take(persist.getModelById(events.Event, req.body.event));
        if (event instanceof Error)
            res.status(404).json(event);
        else {
            if(playerInFlight(event.flights[req.body.flight].players, req.body.player)) {
                res.status(200).json({status: "already in flight"});
                return;
            }
            if (common.objectIdArrayMatch(event.organizations, req.user.organizations)) { // if player is in an org owning event
                req.body.player.addedBy = req.user._id;
                req.body.player.player_id = req.body.id;
                event.flights[req.body.flight].players.push(req.body.player);
                var result = yield csp.take(persist.saveModel(event));
                if (result instanceof Error) {
                    res.status(500).json({error: "Cannot add player"});
                } else {
                    res.status(200).json({status: "Success"})
                }
            } else {
                res.status(405).json({error: 'you must be in the org sponsoring the event'});
            }
        }
    });
});


router.patch('/movePlayer', function (req, res, next) {
    csp.go(function* () {
        var event = yield csp.take(persist.getModelById(events.Event, req.body.event));
        if (event instanceof Error) {
            res.status(404).json(event);
            return;
        }
        if(!playerInFlight(event.flights[req.body.fromFlight].players, req.body.player)) {
            res.status(405).json({error: "Player not in flight"});
            return;
        }
        if(!(event.flights[req.body.toFlight] && event.flights[req.body.fromFlight])) {
            res.status(405).json({error: "Illegal from or to flight"});
            return;
        }
        // use .id virtual element to compare hex string to played._id, a hex string coming from JSON
        var player = event.flights[req.body.fromFlight].players.find(el => el.id === req.body.player._id);
        if(!player) {
            res.status(404).json({error: "player not found"});
            return;
        }
        if(!(authorizedEventUpdate(req.user, player))) {
            res.status(405).json({error: "You can only move yourself or someone you added"});
            return;
        }
        if(playerInFlight(event.flights[req.body.toFlight].players, req.body.player)) {
            res.status(405).json({error: "Player already in flight"});
            return;
        }
        if(event.flights[req.body.toFlight].players.length < event.flights[req.body.toFlight].maxPlayers)
            event.flights[req.body.toFlight].players.push(findPlayerInFilght(event.flights[req.body.fromFlight].players, req.body.player));
        else {
            res.status(405).json({error: "flight is full"});
            return;
        }
        event.flights[req.body.fromFlight].players = removePlayerFromFlight(event.flights[req.body.fromFlight].players, req.body.player);
        var result = yield csp.take(persist.saveModel(event));
        if(result instanceof Error) {
            res.status(500).json(result);
        } else {
            res.status(200).json(result);
        }
    });
});

router.post('/newPlayer', function (req, res) {
    csp.go(function*() {
        // get crypto random value for password. Login should be blocked anyway, but best to be sure
        var pwd = yield csp.take(mailer.generateToken());
        var player = {
            name: req.body.name,
            registered: false,
            email: pwd,
            password: pwd,
            organizations: req.user.organizations,
            addedBy: req.user._id
        };
        var result = yield csp.take(persist.newModel(players.Player, player));
        if (result instanceof Error) {
            res.status(500).json({error: "Cannot create player"});
        } else {
            var reply = {name: result.name, // don't send sensitive info to client
                    _id: result._id};
            res.status(200).json(reply);
        }
    })
});


router.get('/getCurrentUser', function(req, res, next) {
    res.status(200).json({name: req.user.name, _id: req.user._id, organizations: req.user.organizations})
});

router.get('/getAllPlayers', function (req, res, next) {
    csp.go(function*() {
        var result = yield csp.take(persist.getAllPlayersNameAndId(players.Player)); // don't send password, etc to client
        if (result instanceof Error)
            res.status(500).json(result);
        else {
            res.status(200).json(result);
        }
    });
});


module.exports = router;

