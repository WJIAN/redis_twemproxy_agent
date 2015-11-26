var cli = require('cli'),
    Agent = require('./agent');

cli.parse({
  test:    ['t', 'Check if the address of a server is in the TwemProxy config', 'bool', false],
  host:    ['h', 'Redis sentinel hostname', 'string', '127.0.0.1'],
  port:    ['p', 'Redis sentinel port number', 'number', 26379],
  config:  ['f', 'Path to twemproxy config', 'path', '/etc/redis/twemproxy.yml'],
  command: ['c', 'Command to restart twemproxy', 'string', '/etc/init.d/nutcracker restart'],
  log:	   ['l', 'The log file location', 'string', '/var/log/twemproxy_sentinel.log'],
  warnsms: ['w', 'Command to send warn sms', 'string', '/data/redis-twemproxy-agent/bin/warnsms '],
});

cli.main(function (args, options) {
  var config = { nutcracker_config_file: options.config,
                 redis_sentinel_ip:      options.host,
                 redis_sentinel_port:    options.port,
                 restart_command:        options.command, 
		 log_file:		 options.log,
                 warnsms_command:        options.warnsms,
                 test:                   options.test };

  Agent.bootstrap(config);
});
