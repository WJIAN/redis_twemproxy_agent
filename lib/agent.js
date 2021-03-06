var fs   = require('fs'),
    exec = require('child_process').exec,
    path = require('path'),
    os   = require('os'),
    util = require('util'),
    yaml = require('js-yaml');

var redis = require("redis"),
    _     = require("underscore"),
    async = require("async");

function Agent(config){
  if(!_.isObject(config)){
    return console.error("Bad config");
  }

  this.test                   = config.test;
  this.nutcracker_config_file = config.nutcracker_config_file;
  this.redis_sentinel_ip      = config.redis_sentinel_ip;
  this.redis_sentinel_port    = config.redis_sentinel_port;
  this.restart_command        = config.restart_command;
  this.warnsms_command        = config.warnsms_command;
  this.conn_retry_count       = 0;
  this.log_file		      = config.log_file;
}

// Logs a message to the console and to the file
// specifid in the cli.js
Agent.prototype.log = function (message) {
  var theDateTime = (new Date()).toString();

  var theMessage = "[" + theDateTime + "] " + message;
  util.puts(theMessage);

  if(this.log_file != undefined) {
     fs.appendFile(this.log_file, theMessage + '\n', function(err) {

     });
  };
};

// Restarts TwemProxy
Agent.prototype.restart_twemproxy = function(callback){
  var self = this;
  var child = exec(
    this.restart_command,
    function(error, stdout, stderr) {
      self.log("TwemProxy restarted with output: ");
      self.log(stdout);
      if (error !== null) {
        self.log("TwemProxy failed restarting with error: " + error);
      }

      return callback();
    }
  );
};

// Check if the address of a server is in the TwemProxy config
Agent.prototype.check_master_address = function(server, address) {
  this.log("Check Master " + server + " to " + address);
  var found = false;
  _.each(this.doc, function(proxy_data, proxy_name) {
    _.each(proxy_data.servers, function(server_entry, server_idx) {
      // we need to get the server name from the config value
      var items = server_entry.split(/:|\s/)
      var conf_address = items[0] + ':' + items[1];
      if(conf_address == address) {
        // We've found the matching server
        found = true;
      };
    });
  });
  if (!found) {
    this.log("Error: Check Failed! Server: " + server + " Address: " + address + " not found in TwemProxy config!");
  }

  return found
};

// Updates the address of a server, by its name, in the TwemProxy config
Agent.prototype.update_master_address = function(server, new_address, old_address) {
  this.log("Updating Master " + server + ", " + old_address + " to " + new_address);
  var found = false;
  _.each(this.doc, function(proxy_data, proxy_name) {
    _.each(proxy_data.servers, function(server_entry, server_idx) {
      // we need to get the server name from the config value
      var items = server_entry.split(/:|\s/)
      var conf_address = items[0] + ':' + items[1];
      var slot_weight = items[2];
      var slot_name = items[3];

      if(conf_address == old_address) {
        // We've found the matching server
        proxy_data.servers[server_idx] = new_address + ":" + slot_weight + " " + slot_name;
        found = true;
      };
    });
  });
  if (!found) {
    this.log("WARNING: Update Failed! Server: " + server + "Address: " + old_address + " not found in TwemProxy config!");
  }
};

// The handler for the master-switch event from Redis Sentinel
Agent.prototype.switch_master_handler = function(){
  var self = this;

  return function(data) {
    self.log("Received switch-master: " + util.inspect(data));

    self.update_master_address(data.details["master-name"],
      data.details["new-ip"]+":"+data.details["new-port"], 
      data.details["old-ip"]+":"+data.details["old-port"]);

    async.series([
      function(callback) { self.save_twemproxy_config(callback); },
      function(callback) { self.restart_twemproxy(callback); }
    ]);

    //warn sms
    if(self.warnsms_command != '') {
      var warn = "redis master switch "+data.details["master-name"]+" "+data.details["old-ip"]+":"+data.details["old-port"]+" => "+data.details["new-ip"]+":"+data.details["new-port"];
      var content = self.warnsms_command + "\"" + warn + "\"";
      self.log("send warn sms: " + content);
      var child = exec(
        content,
        function(error, stdout, stderr) {
          self.log("Send warn sms with output: ");
          self.log(stdout);
          if (error !== null) {
            self.log("Send warn sms with error: " + error);
          }
        }
      );
    }
  };
};

// Loads the TwemProxy config file from disk
Agent.prototype.load_twemproxy_config = function(callback){
  this.log("Loading TwemProxy config");
  try {
    this.doc = yaml.safeLoad(fs.readFileSync(this.nutcracker_config_file, 'utf8'));
    callback();
  } catch (e) {
    return callback(e);
  }
};

// Saves the TwemProxy config file to disk
Agent.prototype.save_twemproxy_config = function(callback){
  this.log("Saving TwemProxy config");
  fs.writeFile(this.nutcracker_config_file, yaml.safeDump(this.doc), callback);
};

// This will connect to Redis Sentinel and get a list of all current
// master servers, and ensure our config is in Twemproxy config
Agent.prototype.check = function() {
  var self = this;
  var client2 = redis.createClient(
    self.redis_sentinel_port,
    self.redis_sentinel_ip,
    {
      retry_max_delay: 5000
    }
  );
  self.log("Getting latest list of masters...");

  // Get the masters list
  client2.send_command("SENTINEL", ["masters"], function (err, reply) {

    for (var i = 0; i < reply.length; i++) {
      var server = reply[i][1];
      var address = reply[i][3] + ":" + reply[i][5];

      self.log("Master received: " + server + " " + address);
    }

    for (var i = 0; i < reply.length; i++) {
      var server = reply[i][1];
      var address = reply[i][3] + ":" + reply[i][5];

      // Set the IP and Port on the document
      if(self.check_master_address(server, address) != true) {
        process.exit(1);
      }
    }

  self.log("Done, All Redis master server can be found in Twemproxy config file");

  });

  // Cleanup the client
  client2.quit();
};

// Starts the pub/sub monitor on Sentinel
Agent.prototype.start_sentinel = function(){

  this.log("Redis Sentinel TwemProxy Agent Started on: " + (new Date()).toString());
  var handler = this.switch_master_handler();
  var self = this;
  this.client = redis.createClient(
      this.redis_sentinel_port,
      this.redis_sentinel_ip,
      {
 	      retry_max_delay: 5000
      }
    );


  this.client.on("error", function(msg) {
     self.log(msg);
  });

  this.client.on("reconnecting", function(msg) {
     self.conn_retry_count = self.conn_retry_count + 1;
     if (self.conn_retry_count % 1000 == 0) {
         self.log("WARNING: Connection to Redis Sentinel has failed " + self.conn_retry_count + " times!");
     };
  });

  this.client.on("end", function() {
     self.log("Error: Connection to Redis Sentinel was closed!");
  });

  this.client.on('ready', function(err) {
      self.log("Subscribing to sentinel.");

      self.client.on("pmessage", function (p, ch, msg) {
        var aux = msg.split(' '),
        ret =  {
          'master-name': aux[0],
          'old-ip': aux[1],
          'old-port': aux[2],
          'new-ip': aux[3],
          'new-port': aux[4]
        };

        handler({details: ret});
      });

      self.client.psubscribe('+switch-master');

      self.log("success to Subscribing to sentinel.");
  })
};

// Initialisation
Agent.prototype.bootstrap = function(){
  var self = this;

  this.load_twemproxy_config(
    function(error){
    if(error) {
      return console.error(error);
    }

    // check only
    if(self.test == true) {
      return self.check()
    }

    return self.start_sentinel();
  }
  );
};

// Initialisation
Agent.bootstrap = function (config) {
  (new Agent(config)).bootstrap();
};

module.exports = Agent;
