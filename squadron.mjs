class Comms {

  #handlers = new Map();

  init() {
    game.socket.on('module.squadron', this._receiveSocket.bind(this));
  }

  async _receiveSocket({event, data}) {
    const queue = this.#handlers.get(event) ?? [];
    const newHandlers = await queue.reduce( async (remaining, curr) => {
      await curr.handler(...data);
      if (!curr.once) remaining.push(curr);
      return remaining;
    }, []);

    if (newHandlers.length > 0) this.#handlers.set(event, newHandlers);
    else this.#handlers.delete(event);
  }

  #addHandler(moduleEvent, handler, once) {
    const cb = {once, handler};
    if (this.#handlers.has(moduleEvent)) this.#handlers.get(moduleEvent).push(cb);
    else this.#handlers.set(moduleEvent, [cb]);
  }

  on(moduleEvent, handler) {
    this.#addHandler(moduleEvent, handler, false);
  }

  once(moduleEvent, handler) {
    this.#addHandler(moduleEvent, handler, true);
  }

  emit(moduleEvent, ...data) {
    const payload = {event: moduleEvent, data};
    game.socket.emit('module.squadron', payload);

    return this._receiveSocket(payload);
  }

}

class MODULE {

  /**
   * Singleton socket manager
   */
  static comms = new Comms();

  /**
   * Populated at runtime
   */
  static api = null;
  static EVENT = Object.freeze({
    leaderMove: "sq-leader-move",
    followerPause: "sq-follow-pause",
    addFollower: "sq-add-follower",
    addLeader: "sq-add-leader",
    removeFollower: "sq-remove-follower",
    removeLeader: "sq-remove-leader",
    notifyCollision: "sq-notify-collision",  
  });

  static CONST = Object.freeze({
    LEFT: Object.freeze({x:1, y:0, mode:'vector'}),
    UP: Object.freeze({x:0, y:-1, mode:'vector'}),
    DOWN: Object.freeze({x:0, y:1, mode:'vector'}),
    RIGHT: Object.freeze({x:-1, y:0, mode:'vector'}),
    SHADOW: Object.freeze({x:-1, y:-1, z:-1, mode:'rel'}),
    MIRROR: Object.freeze({x:1, y:1, z:1, mode:'rel'}),
    DETECT: Object.freeze({x: 0, y: 0, z: 0, mode: 'detect'}),
    QUERY: true,
  })

  static FLAG = Object.freeze({
    followers: "followers",
    leaders: "leaders",
    paused: "paused",
    lastUser: "user",
  })

  static register(){
    this.comms.init();
  }

  static setting(key){
    return game.settings.get('squadron', key);
  }

  static localize(moduleKey){
    return game.i18n.localize("sqdrn."+moduleKey);
  }

  static format(moduleKey, data = {}){
    return game.i18n.format("sqdrn."+moduleKey, data);
  }

  static firstGM(){
    return game.users.find(u => u.isGM && u.active);
  }

  static isFirstGM(){
    return game.user.id === MODULE.firstGM()?.id;
  }

  static setTargets(placeables = []) {
    const ids = placeables.map( p => p?.id );
    game.user.broadcastActivity({targets: ids});
    game.user.updateTokenTargets(ids);
  }

  static getSize(tokenDoc) {
    if (tokenDoc.object) return tokenDoc.object.bounds;
    
    let {width, height} = tokenDoc;
    const grid = tokenDoc.parent.grid;
    if ( grid.isHexagonal ) {
      if ( grid.columns ) width = (0.75 * Math.floor(width)) + (0.5 * (width % 1)) + 0.25;
      else height = (0.75 * Math.floor(height)) + (0.5 * (height % 1)) + 0.25;
    }
    width *= grid.sizeX;
    height *= grid.sizeY;
    return {width, height};
  }

  static applySettings(settingsData){
    Object.entries(settingsData).forEach(([key, data])=> {
      game.settings.register(
        'squadron', key, {
          name : MODULE.localize(`setting.${key}.name`),
          hint : MODULE.localize(`setting.${key}.hint`),
          ...data
        }
      );
    });
  }

  /* biases toward GM taking action, fallback to individual owners */
  static firstOwner(doc){
    /* null docs could mean an empty lookup, null docs are not owned by anyone */
    if (!doc) return false;

    /* Any GM 'owns' everything */
    const gmOwners = game.users.filter( user => user.isGM && user.active);

    if(gmOwners.length > 0) return gmOwners[0];

    /* users are only owners with permission level 3 */
    const otherOwners = Object.entries(doc.data.permission)
      .filter(([id, level]) => (!game.users.get(id)?.isGM && game.users.get(id)?.active) && level === 3)
      .map(([id, level])=> id);


    return game.users.get(otherOwners[0]);
  }

  static isFirstOwner(doc){
    return game.user.id === MODULE.firstOwner(doc)?.id;
  }
}

class FollowVector extends Ray {
  constructor( A, B ) {
    super( A, B );

    /**
     * The origin z-coordinate
     * @type {number}
     */
    this.z0 = A.z;

    /**
     * The "up" distance of the ray, z1 - z0
     * @type {number}
     */
    this.dz = B.z - A.z;

    this.t0 = A.t;
    this.dt = B.t - A.t;
  }
}

class Logistics {

  static register() {
    this.settings();
  }

  static settings() {
    const config = true;
    const settingsData = {
      collideWalls: {
        scope: "world", config, default: 0, type: Number,
        choices: {
          0: "sqdrn.setting.collideWalls.cOff",
          1: "sqdrn.setting.collideWalls.cPause",
          2: "sqdrn.setting.collideWalls.cTeleport",
        }
      },
    };

    MODULE.applySettings(settingsData);
  }
  
  /**
   *
   * @example
   * ```json
   * {
   *  "leader": {
   *      "tokenId": "br5CLQqneLsRA8dG",
   *      "sceneId": "kjgFSuEJMBUH0gq4",
   *      "followVector": {
   *          "A": {
   *              "x": 1350,
   *              "y": 850,
   *              "z": 0
   *          },
   *          "B": {
   *              "x": 1450,
   *              "y": 950,
   *              "z": 0
   *          },
   *          "y0": 850,
   *          "x0": 1350,
   *          "dx": 100,
   *          "dy": 100,
   *          "slope": 1,
   *          "z0": 0,
   *          "dz": 0
   *      }
   *  },
   *  "followers": [
   *      "o6jXMX22dnYljtVN"
   *  ],
   *  "userId": "dZNkKae5pRvEOgcB"
   * }
   *```
   */

  static containsOwnedFollower(eventData) {
    
    /* are we the first owner of any of the
     *follower tokens that are not paused?
     */
    const isOwner = eventData.followers.reduce( (sum, curr) => {
      if (sum) return sum;
      const token = game.scenes.get(eventData.leader.sceneId).getEmbeddedDocument("Token", curr);
      if (!token) return sum;
      if (MODULE.isFirstOwner(token.actor)) return true;
      return sum;
    },false);

    return isOwner;
  }

  static leaderFirstOwner(eventData) {
    const leader = game.scenes.get(eventData.sceneId).getEmbeddedDocument('Token', eventData.leaderId);
    return MODULE.isFirstOwner(leader?.actor);
  }

  static followerFirstOwner(eventData) {
    const follower = game.scenes.get(eventData.sceneId).getEmbeddedDocument('Token', eventData.followerId);
    return MODULE.isFirstOwner(follower?.actor);
  }

  /* followerData[leaderId]={angle,distance}}
   * where deltaVector is the offset relative
   * to the unit followVector of the leader
   *
   * @param {object} data  {
          leader: {
            tokenId: tokenDoc.id,
            sceneId: tokenDoc.parent.id,
            finalPosition: newLoc,
            followVector
          },
          followers,
        }
   */
  static _moveFollower( followerId, data ) {

    /* only handle *ours* no matter what anybody says */
    const token = game.scenes.get(data.leader.sceneId).getEmbeddedDocument("Token", followerId);
    if (!token || !MODULE.isFirstOwner(token?.actor)) return;

    /* get our follower information */
    const followerData = token.getFlag('squadron', MODULE.FLAG.leaders) ?? {};

    const {delta: deltaInfo, locks, snap} = followerData[data.leader.tokenId] ?? {delta: null};

    /* have i moved independently and am generally paused? */
    const paused = token.getFlag('squadron', MODULE.FLAG.paused);

    /* is this _specific_ leader marked as a persistent follow? */
    if (paused && !locks.follow) return;

    /* null delta means the leader thinks we are following, but are not */
    if (!deltaInfo){
      //console.debug(`Leader ${data.leader.tokenId} thinks ${token.name} is following, but they disagree`);
      MODULE.comms.emit(MODULE.EVENT.removeFollower, {
          leaderId: data.leader.tokenId,
          followerId,
          sceneId: data.leader.sceneId
        });

      return;
    }

    /* from follow vector, calculate our new position */
    let {followVector} = data.leader;

    if ( !(followVector instanceof FollowVector) ){
      /* this was serialized from another client */
      followVector = new FollowVector(followVector.A, followVector.B);
    }
    
    /* record last user in case of collision */
    const user = token.getFlag('squadron', MODULE.FLAG.lastUser) ?? {};

    /* get follower token size offset (translates center to corner) */
    let position = Logistics._calculateNewPosition(followVector, deltaInfo, locks, token);
    foundry.utils.mergeObject(position, {x: token.x, y: token.y}, {overwrite: false});

    /* snap to the grid if requested.*/
    if (snap) {
      foundry.utils.mergeObject(position, token.parent.grid.getSnappedPoint(position, {mode: CONST.GRID_SNAPPING_MODES.CORNER}));
    }

    /* check if we have moved -- i.e. on the 2d canvas */
    const isMove = position.x != token.x || position.y != token.y;

    let moveInfo = {update: {_id: followerId, ...position}, stop: false, user, name: token.name};

    /* if we should check for wall collisions, do that here */
    //Note: we can only check (currently) if the most senior owner is on
    //      the same scene as the event. 
    if((MODULE.setting('collideWalls') > 0) && canvas.scene.id === data.leader.sceneId && isMove) {
      //get centerpoint offset
      const offset = {x: token.object.center.x - token.x, y: token.object.center.y - token.y};
      moveInfo.stop = Logistics._hasCollision([token.x+offset.x, token.y+offset.y, moveInfo.update.x+offset.x, moveInfo.update.y+offset.y]);
      
    }

    return moveInfo;
  }

  /* checks for wall collision along the array form of a ray */
  static _hasCollision(points) {
    const origin = {x: points[0], y: points[1]};
    const destination = {x: points[2], y: points[3]};
    return CONFIG.Canvas.polygonBackends.move.testCollision(origin, destination, {mode:"any", type:"move"});
  }

  /* unit normal is forward */
  static _calculateNewPosition(forwardVector, delta, locks, token){
    const origin = forwardVector.A;
    const {angle, distance, dz, orientation} = delta; 
    const {height, width} = MODULE.getSize(token);
    let pos = {};

    /* Compute X/Y depending on mode */
    if (orientation.mode == 'rel') {
      /* Grab the token's _final_ position in case we are still animating */
      pos.x = token._source.x + orientation.x * forwardVector.dx;
      pos.y = token._source.y + orientation.y * forwardVector.dy;
      if (forwardVector.dt) {
        const ray = new Ray(origin, {x: pos.x + width/2, y: pos.y + height/2}).shiftAngle(-forwardVector.dt);
        pos = {
          x: ray.B.x - width/2,
          y: ray.B.y - height/2,
        };
      }
    } else {
      const offsetAngle = forwardVector.distance < 1e-10 ? forwardVector.A.t : forwardVector.angle;

      /* if planar locked preserve initial orientation */
      const finalAngle = offsetAngle + angle;

      const newLocation = Ray.fromAngle(origin.x, origin.y, finalAngle, distance);

      // give x/y if any 2d movement occured
      if (forwardVector.dx || forwardVector.dy || forwardVector.dt){
        pos.x = newLocation.B.x - width/2;
        pos.y = newLocation.B.y - height/2;
      }

    }

    /* compute elevation change depending on its mode */
    if (forwardVector.dz) {
      switch (locks.elevation) {
        case 'static':
          break;
        case 'offset':
          pos.elevation = origin.z + dz;
          break;
        case 'tether':
          pos.elevation = forwardVector.dz > 0 ? origin.z - dz : origin.z + dz;
          break;
      }
    }

    return pos;

  }

  /* return {Promise} */
  static async handleLeaderMove(eventData) {

    if (!Logistics.containsOwnedFollower(eventData)) return;

    const stopSetting = MODULE.setting('collideWalls') == 1;
    const updates = eventData.followers.map( element => Logistics._moveFollower( element, eventData ) );
    const leader = await fromUuid(`Scene.${eventData.leader.sceneId}.Token.${eventData.leader.tokenId}`);
    const leaderSize = MODULE.getSize(leader);
    const sortedActions = updates.reduce( (acc, curr) => {
      if (curr?.stop === false) {
        acc.moves.push(curr.update);
        return acc;
      }

      if (curr?.stop === true) {
        if (stopSetting) {
          acc.stops.push({
            _id: curr.update._id, 
            [`flags.squadron.${MODULE.FLAG.paused}`]: true
          });
        } else {
          acc.teleports.push({
            ...curr.update,
            x: eventData.leader.followVector.A.x - leaderSize.width / 2 + 10 + acc.teleports.length * 10,
            y: eventData.leader.followVector.A.y - leaderSize.height / 2 + 10 + acc.teleports.length * 10,
          });
        }
      }

      return acc;
    }, {moves: [], stops: [], teleports: []});

    for (const curr of sortedActions.stops) {
      /* notify initiating owner of collision */
      await MODULE.comms.emit(MODULE.EVENT.notifyCollision, {
        tokenId: curr.update._id,
        tokenName: curr.name,
        user: curr.user
      });
    }

    const scene = game.scenes.get(eventData.leader.sceneId);

    await scene.updateEmbeddedDocuments('Token', sortedActions.stops, {squadronEvent: MODULE.EVENT.leaderMove});

    await scene.updateEmbeddedDocuments('Token', sortedActions.teleports, {teleport: true, squadronEvent: MODULE.EVENT.leaderMove});

    return scene.updateEmbeddedDocuments('Token', sortedActions.moves, {squadronEvent: MODULE.EVENT.leaderMove})
  }

  static async handleRemoveFollower(eventData) {

    if (!Logistics.leaderFirstOwner(eventData)) return;

    const leader = game.scenes.get(eventData.sceneId).getEmbeddedDocument('Token', eventData.leaderId);

    const leaderData = (leader.getFlag('squadron', MODULE.FLAG.followers) ?? []);

    /* get new list of followers */
    const newData = leaderData.reduce( (sum, curr) => {
      if (curr == eventData.followerId) return sum;
      sum.push(curr);
      return sum
    }, []);

    if (newData.length > 0) {
      await leader.setFlag('squadron', MODULE.FLAG.followers, newData);
    } else {
      /* no more followers for this leader */
      await leader.unsetFlag('squadron', MODULE.FLAG.followers);
    }
  }

  /**
   * @returns {Promise|undefined}
   */
  static announceStopFollow(tokenDoc) {

    const leaders = tokenDoc.getFlag('squadron', MODULE.FLAG.leaders) ?? {};
    if (Object.keys(leaders).length > 0){

      //console.debug('Notifying leaders of follower remove. Follower:', tokenDoc, 'Leaders:', leaders);
      /* notify each leader that one of their followers is being removed */
      return Promise.all(Object.keys(leaders).map( (leaderId) => {
        return MODULE.comms.emit(MODULE.EVENT.removeFollower,
          {
            leaderId,
            followerId: tokenDoc.id,
            sceneId: tokenDoc.parent.id
          });
      }));

    }
  }

  static async handleRemoveLeader(eventData) {

    if (!Logistics.followerFirstOwner(eventData)) return;

    const follower = game.scenes.get(eventData.sceneId).getEmbeddedDocument('Token', eventData.followerId);

    await follower.update({
      [`flags.squadron.-=${MODULE.FLAG.leaders}`]: null,
      [`flags.squadron.-=${MODULE.FLAG.paused}`]: null
    });

  }

  
  /* leaderData = [follower ids] */
  static async handleAddFollower(eventData) {

    if (!Logistics.leaderFirstOwner(eventData)) return;
    
    /* get the current follower flags */
    const leader = game.scenes.get(eventData.sceneId).getEmbeddedDocument('Token', eventData.leaderId);
    let leaderData = foundry.utils.duplicate(leader.getFlag('squadron', MODULE.FLAG.followers) ?? []);

    /* are they already following? */
    if (leaderData.includes(eventData.followerId)) return; 

    leaderData.push(eventData.followerId);

    await leader.setFlag('squadron', MODULE.FLAG.followers, leaderData);
  }

  static async handleAddLeader(eventData) {

    if (!Logistics.followerFirstOwner(eventData)) return;

    const {leaderId, followerId, sceneId, orientationVector, locks, initiator, snap} = eventData;

    const scene = game.scenes.get(sceneId);

    const leaderToken = scene.getEmbeddedDocument('Token', leaderId);
    let followerToken = scene.getEmbeddedDocument('Token', followerId);

    const followerDelta = Logistics._calculateFollowerDelta(leaderToken.object, orientationVector, followerToken.object);

    let currentFollowInfo = foundry.utils.duplicate(followerToken.getFlag('squadron', MODULE.FLAG.leaders) ?? {});

    /* stamp in our new data */
    currentFollowInfo[leaderId] = { delta: followerDelta, locks, snap };

    const flags = {
      [MODULE.FLAG.leaders] : currentFollowInfo,
      [MODULE.FLAG.paused]: false,
      [MODULE.FLAG.lastUser]: initiator,
    };

    /* store the data */
    await followerToken.update({'flags.squadron': flags});
  }

  static _computeLeaderAngle(orientationVector) {
    const ray = new Ray({x: 0, y:0}, orientationVector);
    return ray.angle;
  }

  static _calculateFollowerDelta(leaderPlaceable, orientationVector, followerPlaceable){
    
    const leaderAngle = Logistics._computeLeaderAngle(orientationVector);

    const followerVector = {x: followerPlaceable.center.x - leaderPlaceable.center.x, y: followerPlaceable.center.y - leaderPlaceable.center.y};
    const followerRay = new Ray({x:0, y:0}, followerVector);
    const followerAngle = followerRay.angle;

    return {angle: followerAngle + leaderAngle, distance: followerRay.distance, dz: followerPlaceable.document.elevation - leaderPlaceable.document.elevation, orientation: orientationVector}
  }

  /* Will erase all squadron data from all scenes (if parameter == true) or
   * just the currently viewed scene (if false).
   */
  static disband(global = false) {

    if (global) {
      game.scenes.forEach( (scene) => {
        Logistics._disbandScene(scene);
      });
    } else {
      return Logistics._disbandScene(canvas.scene);
    }
  }

  static _disbandScene(scene) {
    const tokens = scene.getEmbeddedCollection('Token').filter( token => token.flags?.['squadron'] );
    const updates = tokens.map( (token) => {return { _id: token.id, 'flags.-=squadron':null}});
    return scene.updateEmbeddedDocuments('Token', updates);
  }
}

class Formation extends Application {
  static get name() { return 'Formation' };
  static get template() { return `modules/squadron/apps/${this.name}/template.hbs` };

  static register() {
    loadTemplates([this.template]);

    MODULE.applySettings({
      creationPings: {
        scope: 'world',
        config: true,
        default: 0,
        type: Number,
        choices: {
          0: 'sqdrn.setting.creationPings.all',
          1: 'sqdrn.setting.creationPings.players',
          2: 'sqdrn.setting.creationPings.gm',
          3: 'sqdrn.setting.creationPings.none',
        },
      }
    });
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      classes: [...super.defaultOptions.classes, 'squadron', this.name],
      template: this.template,
      title: 'sqdrn.app.title',
      id: 'squadron-Formation',
      top: 150,
    });
  }

  constructor({leader = null, followers = [], scene = null}, options = {}) {
    super(options);

    if (typeof followers == 'string') followers = [followers];

    if(followers.length == 0 || !scene) {
      throw new Error('Follower IDs and scene ID required');
    }

    this.squad = {leader, followers, scene};
  }

  get leader() {
    return game.scenes.get(this.squad.scene).tokens.get(this.squad.leader);
  }

  activateListeners(html) {
    super.activateListeners(html);
    this.root = html[0].parentElement;
    this.forms = this.root.querySelectorAll('form');

    this.root.addEventListener('click', this._handleClick.bind(this)); 
  }

  _handleClick(evt) {
    const button = evt.target.closest('button');
    const value = button?.dataset?.value;
    if (!value) return;

    evt.preventDefault();
    evt.stopPropagation();

    /* Even if we were assigned a leader on construction, always use
     * the current user target (if any) */
    this.squad.leader = game.user.targets.first()?.id ?? this.squad.leader;

    if (!this.squad.leader) {
      ui.notifications.info(MODULE.localize('feedback.pickTarget'));
      return;
    }
    
    const formData = {
      'elevation': 'tether',
      'snap-grid': false,
      'no-pause': false,
    };

    for (const form of this.forms) {
      const data = new FormData(form);
      Reflect.ownKeys(formData).forEach( key => {
        if (data.has(key)) formData[key] = data.get(key);
      });
    }

    const squadData = {
      orientationVector: MODULE.CONST[value],
      snap: !!formData['snap-grid'],
      locks: {
        elevation: formData['elevation'],
        follow: !!formData['no-pause']
      }
    };
    
    this.close();

    return this.startFollow(squadData);
  }

  async startFollow(squadData, silent = false) {
    if (!this.squad.leader) {
      throw new Error('Leader token required for squadron creation.');
    }

    if (squadData.orientationVector.mode === 'detect') {
      const tRot = this.leader?.rotation; 
      const tRay = Ray.fromAngle(0,0, Math.toRadians(tRot + 90), 1);
      squadData.orientationVector = {
        mode: 'vector',
        x: -tRay.B.x,
        y: tRay.B.y,
      };
    } 


    const data = [];
    for (const follower of this.squad.followers) {
      const eventData = foundry.utils.mergeObject(squadData, {
        initiator: game.user.id,
        leaderId: this.squad.leader,
        followerId: follower,
        sceneId: this.squad.scene,
      }, {overwrite: true, inplace: false});

      /* trigger all relevant events */
      await MODULE.comms.emit(MODULE.EVENT.addFollower, eventData);
      await MODULE.comms.emit(MODULE.EVENT.addLeader, eventData);

      data.push(eventData);
    }

    /* confirmation info */
    if (!silent) {
      const type = squadData.orientationVector.mode === 'vector' ? 'formation' : 'follow';

      const confirmInfo = MODULE.format(`feedback.pickConfirm.${type}`, {num: data.length});
      ui.notifications.info(confirmInfo);

      switch (MODULE.setting('creationPings')) {
        case 0:
          break;
        case 1:
          if (game.user.hasRole(CONST.USER_ROLES.PLAYER) && !game.user.isGM) break;
          return data;
        case 2:
          if (game.user.isGM) break;
          return data;
        case 3:
          return data;
      }

      const leaderObject = this.leader.object;
      const followerObjects = this.squad.followers.map( id => game.scenes.get(this.squad.scene).tokens.get(id)?.object ).filter( p => p );

      /* Chevron on leader */
      if (leaderObject) {
        const bounds = leaderObject.bounds;
        canvas.ping(bounds.center, {
          style: CONFIG.Canvas.pings.types.PULL,
          size: (bounds.width + bounds.height) / 2,
          duration: 1000,
        });
      }

      switch (type) {
        case 'formation':
          /* Chevron on leader, rotated arrows on followers */
          const rotRay = new Ray({
            x: -squadData.orientationVector.x,
            y: squadData.orientationVector.y
          },{
            x: 0, y: 0
          });
          followerObjects.forEach( p => {
            const bounds = p.bounds;
            canvas.ping(bounds.center, {
              style: CONFIG.Canvas.pings.types.ARROW,
              size: (bounds.width + bounds.height),
              rotation: rotRay.angle + Math.PI,
              duration: 1500,
            });
          });

          break;
        case 'follow':
          /* Chevron on leader, pulses on followers */
          followerObjects.forEach( p => {
            const bounds = p.bounds;
            canvas.ping(bounds.center, {
              style: CONFIG.Canvas.pings.types.PULSE,
              size: (bounds.width + bounds.height) / 2,
              rings: 4,
              duration: 1000,
            });
          });

          break;
      }

    }

    return data;
  }
}

class UserInterface {

  static _dragDrop = new DragDrop({
    dragSelector: '.control-icon.squadron', 
    callbacks: {
      dragstart: this._onDragStart,
    },
  });

  static _dragImg = null;

  static register() {
    this.settings();
    this.hooks();
  }

  static settings() {
    const config = true;
    const settingsData = {
      silentCollide: {
        scope: "client", config, default: false, type: Boolean
      }
    };

    MODULE.applySettings(settingsData);
  }

  static hooks(){
    Hooks.once('renderTokenHUD', this._cacheDragImg);
    Hooks.on('renderTokenHUD', this._renderTokenHUD);
    Hooks.on('dropCanvasData', this._onCanvasDrop);
  }

  static _cacheDragImg() {
    UserInterface._dragImg = new Image();
    UserInterface._dragImg.src = 'icons/svg/target.svg';
  }

  static _renderTokenHUD(app, html){
    const token = app?.object?.document;
    if (!token) return;

    const allSelected = (fn) => {
      (canvas.tokens.controlled ?? [{document: token}]).forEach( selected => fn(selected.document) );
    };

    /* which button should we show? */
    const paused = token.getFlag('squadron', MODULE.FLAG.paused);
    if (paused) {

      /* we are following, but have paused */
      UserInterface._addHudButton(html, token, 'sqdrn.workflow.rejoin', 'fa-sitemap', 
        ()=>{ allSelected(UserInterface.resume);});
    } else if (paused === undefined) {

      /* if the pause flag doesnt exist, we arent following anyone */
      /* special handling of multi-selected for this one, dont use helper */
      UserInterface._addHudButton(html, token, 'sqdrn.workflow.pick', 'fa-users',
        () => { 
          new Formation({
            followers: canvas.tokens.controlled.map( p => p.id ),
            scene: canvas.scene.id,
          }).render(true);
        }, true);
    } else {

      /* otherwise, we are following normally and have the option to stop */
      UserInterface._addHudButton(html, token, 'sqdrn.workflow.leave', 'fa-users-slash', 
        ()=>{ allSelected(UserInterface.stop);});
    }
  }

  static _addHudButton(html, selectedToken, title, icon, clickEvent, draggable = false) {

    if (!selectedToken) return;
    
    const button = new DocumentFragment();
    button.append(document.createElement('div'));
    button.firstElementChild.classList.add('control-icon', 'squadron');
    button.firstElementChild.dataset.tooltip = title;

    const iconElement = document.createElement('i');
    iconElement.classList.add('fas', icon);
    button.firstElementChild.append(iconElement);
    button.firstElementChild.addEventListener('click', clickEvent);

    html[0].querySelector('.col.left').append(button);
    if (draggable) {
      UserInterface._dragDrop.bind(html[0]);
      html[0].addEventListener('dragend', UserInterface._onDragEnd);
    }
  }

  static _initialTransform = 'inherit';

  static _shrinkHUD(hud) {
    if (!hud) return;
    const el = hud.element[0];
    el.style.transition = 'transform 0.5s ease-in';
    UserInterface._initialTransform = el.style.transform;
    el.style.transform += ' scale(0.5) translate(50%, 50%)';
  }

  /**
   * Restores HUD to initial styling. Half second delay to match UserInterface._shrinkHUD.
   *
   * @static
   * @param {TokenHUD} hud
   * @returns Promise<> Restore  HUD animation has completed
   * @memberof UserInterface
   */
  static _restoreHUD(hud) {
    if (!hud) return;
    hud.element[0].style.transform = UserInterface._initialTransform;

    return new Promise( resolve => (setTimeout( () => {
      hud.element[0].style.transition = 'inherit';
      resolve();
    }, 500)));
  }

  static _onDragEnd(evt) {
    UserInterface._restoreHUD(canvas.tokens.hud);
  }

  static _onDragStart(evt) {
    const dragData = {
      type: 'squadron/target',
      selected: canvas.tokens.controlled.map( t => t.id ),
      alt: evt.altKey,
      ctrl: evt.ctrlKey,
    };
    //evt.stopPropagation();
    evt.dataTransfer.setData("text/plain", JSON.stringify(dragData));
    const {width, height} = evt.target.getBoundingClientRect();
    const preview = DragDrop.createDragImage(UserInterface._dragImg, width, height);
    evt.dataTransfer.setDragImage(preview, width/2, height/2);
    evt.dataTransfer.effectAllowed = 'link';
    evt.dataTransfer.dropEffect = 'link';
    UserInterface._shrinkHUD(canvas.tokens.hud);
  }

  static _onCanvasDrop(canvas, {type, selected = [], x, y, alt, ctrl}) {
    if (type !== 'squadron/target' || selected?.length == 0) return;
    
    const anim = UserInterface._restoreHUD(canvas.tokens.hud);

    /* create 20x20 target area to find placeables */
    let targets = [];
    const hitArea = new PIXI.Rectangle(x - 10, y - 10, 20, 20);
    for (const token of canvas.tokens.placeables.filter(t => t.isVisible && !selected.includes(t.id))) {
      if (token._overlapsSelection(hitArea)) targets.push(token);
    }
    targets.sort( (left, right) => left.document.sort > right.document.sort ? -1 : left.document.sort < right.document.sort ? 1 : 0);

    
    if (targets.length > 0) {
      const formation = new Formation({
        leader: targets.at(0).id,
        followers: selected,
        scene: canvas.scene.id
      });

      if (alt) {
        MODULE.setTargets([targets.at(0)]);
        formation.render(true);

      } else if (ctrl) {
        anim.then( _ => {
          formation.startFollow({
            orientationVector: MODULE.CONST.SHADOW,
            snap: false,
            locks: {
              elevation: 'offset', 
              follow: true,
            }
          });
        });
      } else {
        anim.then( _ => {
          formation.startFollow({
            orientationVector: MODULE.CONST.DETECT,
            snap: true,
            locks: {
              elevation: 'tether',
              follow: false,
            }
          });
        });
      }
    }

    return false;
  }

  static async stop(followerToken) {
    await Logistics.announceStopFollow(followerToken);
    await followerToken.update({'flags.-=squadron': null});
    if (canvas.tokens.hud.object?.id === followerToken.id) {
      canvas.tokens.hud.render(false);
    }
  }

  static async resume(followerToken) {
    await followerToken.setFlag('squadron', MODULE.FLAG.paused, false);
    if (canvas.tokens.hud.object?.id === followerToken.id) {
      canvas.tokens.hud.render(false);
    }
  }
}

class Lookout {
  static register() {
    Lookout.hooks();
  }

  static hooks() {
    Hooks.on("preUpdateToken", Lookout._preUpdateToken);
    Hooks.on("updateToken", Lookout._updateToken);
    Hooks.on("deleteToken", Lookout._deleteToken);
    Hooks.on("pasteToken", Lookout._pasteToken);
    Hooks.on("preCreateToken", Lookout._preCreateToken);

    MODULE.comms.on( 
      MODULE.EVENT.leaderMove,
      Logistics.handleLeaderMove,
    );

    MODULE.comms.on(
      MODULE.EVENT.addFollower,
      Logistics.handleAddFollower
    );

    MODULE.comms.on(
      MODULE.EVENT.addLeader,
      Logistics.handleAddLeader
    );

    MODULE.comms.on(
      MODULE.EVENT.removeFollower,
      Logistics.handleRemoveFollower
    );

    MODULE.comms.on(
      MODULE.EVENT.removeLeader,
      Logistics.handleRemoveLeader,
    );

    MODULE.comms.on(
      MODULE.EVENT.notifyCollision,
      (eventData) => {
        if (eventData.user === game.user.id && !MODULE.setting('silentCollide')) {

          ui.notifications.warn(MODULE.format('feedback.wallCollision', {tokenId: eventData.tokenId, tokenName: eventData.tokenName}));
        }
      }
    );
  }

  static _preCreateToken(token /*data, options*/) {
    token.updateSource({ "flags.-=squadron": null });
  }

  static _pasteToken(/*sourceArray*/ _, createArray) {
    /* strip any formation info from the new tokens */
    createArray.forEach((data) => delete data.flags?.squadron);
  }

  static _deleteToken(tokenDoc, /*options*/ _, user) {
    /* only handle our initiated moves */
    if (user != game.user.id) return;

    /* am I a leader? */
    const followers = tokenDoc.getFlag('squadron', MODULE.FLAG.followers) ?? [];
    if (followers.length > 0) {
      /* notify each follower that their leader is being removed */
      followers.forEach( followerId => MODULE.comms.emit(MODULE.EVENT.removeLeader, {
        leaderId: tokenDoc.id,
        followerId,
        sceneId: tokenDoc.parent.id,
      }));
    }

    /* am I a follower? */
    Logistics.announceStopFollow(tokenDoc);
  }

  static _shouldTrack(change, ignoreRotation = false) {
    const position = typeof change.x === "number"
      || typeof change.y === "number"
      || typeof change.elevation === "number";
    return ignoreRotation ? position : (position || typeof change.rotation === "number");
  }

  static _getLocation(tokenDoc, changes = {}) {
    const {width, height} = MODULE.getSize(tokenDoc);
    return {
      x: (changes.x ?? tokenDoc._source.x) + width/2,
      y: (changes.y ?? tokenDoc._source.y) + height/2,
      z: changes.elevation ?? tokenDoc.elevation,
      t: Math.toRadians((changes.rotation ?? tokenDoc.rotation) - 90),
    };
  }

  static _preUpdateToken(tokenDoc, update, options /*, user*/) {
    if (Lookout._shouldTrack(update)) {
      /* store 'old' location */
      const loc = Lookout._getLocation(tokenDoc);
      foundry.utils.mergeObject(options, { oldLoc: {[tokenDoc.id]: loc} });
    }
  }

  static _updateToken(tokenDoc, update, options, user) {
    /* only handle our initiated moves */
    if (user != game.user.id) return;

    if (Lookout._shouldTrack(update)) {
      /* am I a leader? */
      const followers =
        tokenDoc.getFlag('squadron', MODULE.FLAG.followers) ?? [];

      if (followers.length > 0) {

        const newLoc = Lookout._getLocation(tokenDoc, update);
        const followVector = new FollowVector(newLoc, options.oldLoc[tokenDoc.id]);
        const data = {
          leader: {
            tokenId: tokenDoc.id,
            sceneId: tokenDoc.parent.id,
            followVector,
          },
          followers,
        };

        MODULE.comms.emit(MODULE.EVENT.leaderMove, data);
      }
      
      // FOLLOWERS
      if (options.squadronEvent == MODULE.EVENT.leaderMove) {
        /* do not respond to our own move events */
        return;
      }

      /* am I a follower and this movement is not only rotation? Pause */
      const leaders = tokenDoc.getFlag('squadron', MODULE.FLAG.leaders);
      if (leaders && Object.keys(leaders).length > 0 && Lookout._shouldTrack(update, true)) {
        Lookout.pause(tokenDoc);
      }
    }
  }

  static async pause(tokenDoc) {
    await tokenDoc.setFlag('squadron', MODULE.FLAG.paused, true);
  }

  static async addFollower(
    leaderId,
    followerIds,
    sceneId,
    orientation = MODULE.CONST.QUERY,
    options = {}
  ) {
    const formation = new MODULE.api.Formation({
      leader: leaderId,
      followers: followerIds,
      scene: sceneId,
    });

    if (orientation === MODULE.CONST.QUERY) {
      /* ask for orientation */
      return formation.render(true);
    }

    return formation.startFollow({orientationVector: orientation, ...options});
  }
}

const SUB_MODULES = {
  MODULE,
  UserInterface,
  Lookout,
  Logistics,
  Formation,
};

globalThis['squadron'] = MODULE.api = {
  disband: Logistics.disband,
  Formation,
  follow: Lookout.addFollower,
  stop: UserInterface.stop,
  pause: Lookout.pause,
  resume: UserInterface.resume,
};

/** Initialize all modules */
Hooks.on(`setup`, () => {
  Object.values(SUB_MODULES).forEach(cl => cl.register());
});
//# sourceMappingURL=squadron.mjs.map
