import * as tradfri from "node-tradfri-client";

const ALL_GROUPS = -1;
const ALL_DEVICES = -2;

module.exports = function(RED) {

  RED.httpAdmin.get('/tradfri', RED.auth.needsPermission('tradfri.read'), function(req, res) {
    // Get config node
    const node = RED.nodes.getNode(req.query.nodeId);
    if (!node) {
      res.json({
        error: true
      })
      return
    }

    // Get current groups and lights
    const lights = node.getLights()
    const groups = node.getGroups()
    const scenes = node.getScenes()

    // Build data structure of groups with their lights
    const data = {}
    for (const id in groups) {
      const group = groups[id]
      data[id] = {
        id,
        name: group.name,
        lights: group.deviceIDs.reduce((result, deviceId) => {
          if (lights[deviceId]) {
            result[deviceId] = lights[deviceId].name
          }
          return result
        }, {}),
        scenes: scenes[id].reduce((result, scene) => {
           result[scene.instanceId] = scene.name
           return result
        }, {})
      }
    }
    RED.log.trace(`[Tradfri: API] Received API request from: '${req}' and answered succesfully.`);
    res.json({ data })
  });

  function TradfriConnectionNode(config) {
    var node = this;
    RED.nodes.createNode(node, config);
    node.name = config.name;
    node.address = config.address;

    if ((typeof node.credentials.identity === 'undefined' && typeof node.credentials.psk !== 'undefined') || (typeof node.credentials.identity !== 'undefined' && typeof node.credentials.psk === 'undefined')) {
      RED.log.error("Must provide both identity and PSK or leave both blank to generate new credentials from security code.");
    }
    if (typeof node.credentials.identity === 'undefined' && typeof node.credentials.psk === 'undefined' && typeof node.credentials.securityCode === 'undefined') {
      RED.log.error("Must provide either identity and PSK or a security code to connect to the Tradfri hub");
    }

    var _lights = {};
    let _groups = {};
    let _scenes = {};
    var _listeners = {};
    var _client = null;
    var groupTimers = new Set();

    var _deviceUpdatedCallback = (accessory: tradfri.Accessory) => {
      if (accessory.type === tradfri.AccessoryTypes.lightbulb) {
        _lights[accessory.instanceId] = accessory;
      }
      if (_listeners[accessory.instanceId]) {
        for (let nodeId in _listeners[accessory.instanceId]) {
          _listeners[accessory.instanceId][nodeId](accessory);
        }
      }
      if ( _listeners[ALL_DEVICES])
      {
        for (let nodeId in _listeners[ALL_DEVICES]) {
          _listeners[ALL_DEVICES][nodeId](accessory);
        }
      }
    }

    var _groupUpdatedCallback = (group: tradfri.Group) => {
      _groups[group.instanceId] = group;
      if (_listeners[group.instanceId]) {
        for (let nodeId in _listeners[group.instanceId]) {
          _listeners[group.instanceId][nodeId](group);
        }
      }
      if ( _listeners[ALL_GROUPS])
      {
        for (let nodeId in _listeners[ALL_GROUPS]) {
          _listeners[ALL_GROUPS][nodeId](group);
        }
      }
    }

    var _sceneUpdatedCallback = (groupId: number, scene: tradfri.Scene) => {
      if (!_scenes[groupId]) {
        _scenes[groupId] = []
      }
      _scenes[groupId].push(scene);
    }

    let _setupClient = async () => {
      let loggerFunction = (message: string, severity: string) => {
        RED.log.trace(severity + ", " + message);
      }
      let client = new tradfri.TradfriClient(node.address);
      if (typeof node.credentials.identity === 'undefined' && typeof node.credentials.psk === 'undefined') {
        const { identity, psk } = await client.authenticate(node.credentials.securityCode);
        node.credentials.securityCode = null;
        node.credentials.identity = identity;
        node.credentials.psk = psk;
        RED.nodes.addCredentials(node.id, node.credentials);
      }
      if (await client.connect(node.credentials.identity, node.credentials.psk)) {
        RED.log.trace(`[Tradfri: ${node.id}] Connected using Identity:'${node.credentials.identity}' and PSK: '${node.credentials.psk}'`);
        client.on("device updated", _deviceUpdatedCallback);
        client.on("group updated", _groupUpdatedCallback);
        client.on("scene updated", _sceneUpdatedCallback);
        client.observeDevices();
        client.observeGroupsAndScenes();
        _client = client;
      } else {
        throw new Error(`Client not available`);
      }
    }

    let _reconnect = async () => {
      let timeout = 5000;
      if (_client != null) {
        _client.destroy();
        _client = null;
      }
      while (_client == null) {
        try {
          await _setupClient();
        } catch (e) {
          RED.log.trace(`[Tradfri: ${node.id}] ${e.toString()}, reconnecting...`);
        }
        await new Promise(resolve => setTimeout(resolve, timeout));
      }
    }

    let pingInterval = 30;
    let _ping = setInterval(async () => {
      try {
        let client = await node.getClient();
        let res = await client.ping();
        RED.log.trace(`[Tradfri: ${node.id}] ping returned '${res}'`);
      } catch (e) {
        RED.log.trace(`[Tradfri: ${node.id}] ping returned '${e.toString()}'`);
      }
    }, pingInterval * 1000);

    _reconnect();

    node.getClient = async (): Promise<tradfri.TradfriClient> => {
      let maxRetries = 5;
      let timeout = 2;
      for (let i = 0; i < maxRetries; i++) {
        if (_client == null) {
          await new Promise(resolve => setTimeout(resolve, timeout * 1000));
        } else {
          return _client;
        }
      }
      throw new Error('Client not available');
    }

    node.getLight = async (instanceId: number): Promise<tradfri.Accessory> => {
      let maxRetries = 5;
      let timeout = 2;
      for (let i = 0; i < maxRetries; i++) {
        if (_lights[instanceId] == null) {
          await new Promise(resolve => setTimeout(resolve, timeout * 1000));
        } else {
          return _lights[instanceId];
        }
      }
      throw new Error('Light ID not available');
    }

    node.getLightByName = async (name: string): Promise<tradfri.Accessory> => {
      let maxRetries = 5;
      let timeout = 2;
      for (let i = 0; i < maxRetries; i++) {
        let id = Object.keys(_lights).find( id => _lights[id].name.toLowerCase() === name.toLowerCase() );
        if (!id) {
          await new Promise(resolve => setTimeout(resolve, timeout * 1000));
        } else {
          return _lights[id];
        }
      }
      throw new Error('Light name not available');
    }

    node.getGroup = async (instanceId: number): Promise<tradfri.Group> => {
      let maxRetries = 5;
      let timeout = 2;
      for (let i = 0; i < maxRetries; i++) {
        if (_groups[instanceId] == null) {
          await new Promise(resolve => setTimeout(resolve, timeout * 1000));
        } else {
          return _groups[instanceId];
        }
      }
      throw new Error('Group ID not available');
    }

    node.getGroupByName = async (name: string): Promise<tradfri.Group> => {
      let maxRetries = 5;
      let timeout = 2;
      for (let i = 0; i < maxRetries; i++) {
        let id = Object.keys(_groups).find( id => _groups[id].name.toLowerCase() === name.toLowerCase() );
        if (!id) {
          await new Promise(resolve => setTimeout(resolve, timeout * 1000));
        } else {
          return _groups[id];
        }
      }
      throw new Error('Group name not available');
    }

    node.getGroupByDevice = (accessory: tradfri.Accessory): Promise<tradfri.Group> => {
      //var _getGroup = (accessory: tradfri.Accessory) => {
        for (let instanceId in _client.groups)
        {
            // Device in group? Return group
            if ( _client.groups[instanceId].group.deviceIDs.indexOf( accessory.instanceId ) !== -1 )
                return _client.groups[instanceId].group;
        }

        // Device not found in any registered group
        return null;
    }

    node.getLights = () => {
      return _lights;
    }

    node.getGroups = () => {
      return _groups;
    }

    node.getScenes = () => {
      return _scenes;
    }

    node.register = (nodeId: string, instanceId: number, callback: (arg: any) => void, includeGroup: boolean): void => {
      if (!_listeners[instanceId]) {
        _listeners[instanceId] = {};
      }
      _listeners[instanceId][nodeId] = ( data ) => {

        callback(data);
        if (includeGroup)
        {
          let group = node.getGroupByDevice(data);
          if (group)
          {
            // Add delay to throttle group event
            if (!groupTimers.has(group.instanceId))
            {
              //RED.log.trace("[Tradfri] add group timer");
              groupTimers.add(group.instanceId);
              setTimeout( () =>
              {
                // Group does not reflect light status properly (hence this injected callback); fake it
                group.onOff = group.deviceIDs.some( id => _lights[id] && _lights[id].lightList && _lights[id].lightList[0].onOff );

                callback(group);
                //_groupUpdatedCallback.bind(this, group);
                groupTimers.delete(group.instanceId);
              }, 200);
            }
          }

        }
      }
      RED.log.info(`[Tradfri: ${nodeId}] registered event listener for ${instanceId}`);
    }

    node.unregister = (nodeId: string): void => {
      for (let instanceId in _listeners) {
        if (_listeners[instanceId].hasOwnProperty(nodeId)) {
          delete _listeners[instanceId][nodeId];
          RED.log.info(`[Tradfri: ${nodeId}] unregistered event listeners`);
        }
      }
    }

    node.on('close', () => {
      clearInterval(_ping);
      if (_client != null) {
        _client.destroy();
        _client = null;
      }
      RED.log.debug(`[Tradfri: ${node.id}] Config was closed`);
    });

  }

  RED.nodes.registerType("tradfri-connection", TradfriConnectionNode, {
    credentials: {
      securityCode: { type: "text" },
      identity: { type: "text" },
      psk: { type: "text" }
    }
  });

  function TradfriNode(config) {
    var node = this;
    RED.nodes.createNode(node, config);
    node.name = config.name;
    node.deviceId = config.deviceId;
    node.groupId = config.groupId;
    node.observe = config.observe;
    node.includeGroup = config.includeGroup;
    var _config = RED.nodes.getNode(config.connection);

    var _send = (payload: any) => {
      let msg = Object.assign({}, payload);
      delete msg.isProxy
      delete msg.options
      delete msg.type
      delete msg.client

      RED.log.trace(`[Tradfri: ${node.id}] recieved update for '${msg.name}' (${msg.instanceId})`);
      node.send({ topic: "tradfri", payload: msg });
    }

    var _handleStatus = async () => {
      try {
        let payload
        if (node.deviceId === '') {
          payload = await _config.getGroup(node.groupId);
        } else {
          payload = await _config.getLight(node.deviceId);
        }
        _send(payload);
        RED.log.trace(`[Tradfri: ${node.id}] Status request successful`);
      } catch (e) {
        RED.log.info(`[Tradfri: ${node.id}] Status request unsuccessful, '${e.toString()}'`);
      }
    }

    var _handleScenes = async () => {
      try {
        let payload
        payload = await _config.getScene(node.groupId);
        _send(payload);
        RED.log.trace(`[Tradfri: ${node.id}] Scenes request successful`);
      } catch (e) {
        RED.log.info(`[Tradfri: ${node.id}] Scenes request unsuccessful, '${e.toString()}'`);
      }
    }

    var _handleOp = async (payload: any) => {
      try {
        // Prepare operation
        if (!payload || Object.keys(payload).length === 0) {
          return;
        }
        let operation = Object.assign({ transitionTime: 0 }, payload);

        let client = await _config.getClient();
        let deviceId = payload.deviceId || node.deviceId;
        let groupId = payload.groupId || node.groupId;
        let result;
        
        // Group or light operation?
        if ( payload.groupName ) {
          const group = await _config.getGroupByName(payload.groupName);
          result = await client.operateGroup(group, operation, true);
        } else if ( payload.deviceName ) {
          const light = await _config.getLightByName(payload.deviceName);
          result = await client.operateLight(light, operation);
        }
        if (groupId) {
          const group = await _config.getGroup(groupId);
          result = await client.operateGroup(group, operation, true);
        } else {
          const light = await _config.getLight(deviceId);
          result = await client.operateLight(light, operation);
        }

        RED.log.trace(`[Tradfri: ${node.id}] Operation '${JSON.stringify(operation)}' returned '${result}'`);
      } catch (e) {
        RED.log.info(`[Tradfri: ${node.id}] Operation '${JSON.stringify(payload)}' unsuccessful, '${e.toString()}'`);
      }
    }

    if (node.observe) {
      _config.register(node.id, node.groupId, _send);
      if (node.deviceId !== '') {
        _config.register(node.id, node.deviceId, _send, node.includeGroup);
      }
    }

    node.on('input', function(msg) {
      (async () => {
        if (msg.hasOwnProperty('payload')) {
          if (msg.payload === "status") {
            msg.payload = { status: true };
          } else if (msg.payload === "scenes") {
            msg.payload = { scenes: true };
          }

          let isStatus = msg.payload.hasOwnProperty('status');
          let isScenes = msg.payload.hasOwnProperty('scenes');

          if (isStatus) {
            _handleStatus();
          } else if (isScenes) {
            _handleScenes();
          } else {
            _handleOp(msg.payload);
          }
        }
      })();
    });

    node.on('close', function() {
      RED.log.debug(`[Tradfri: ${node.id}] Node was closed`);
      _config.unregister(node.id);
    });
  }
  RED.nodes.registerType("tradfri", TradfriNode);
}
