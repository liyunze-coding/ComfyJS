import { parseMessage } from "./parseFast";
import { createWebSocket } from "./socket";
import { authenticate, joinChannel, leaveChannel, ping, pong, ProcessedMessage, processMessage, replyChat, requestCapabilities, sendChat, TwitchEventType } from "./twitch";

export type TwitchEventHandler = ( context? : any ) => void;
export type TwitchChatMode = {
	emoteOnly : boolean;
	followersOnly : boolean;
	subscribersOnly : boolean;
	r9k : boolean; // Unique Chat Mode
	slow : boolean;
	language : string;
};

export class TwitchEvents {
	#ws : WebSocket | undefined;
	#username : string;
	#password : string | undefined;
	#pingTimer : ReturnType<typeof setInterval> | undefined;
	#pingTime : number = 0;
	#latency : number = -1;
	debug : boolean;
	reconnects : number = 0;
	channels : string[];
	chatModes : { [ channel : string ] : TwitchChatMode } = {};
	handlers : Partial<{ [ key in TwitchEventType ] : TwitchEventHandler | undefined }> = {};

	constructor( username : string, password? : string, channels? : string[] | string, isDebug? : boolean ) {
		this.#username = username;
		this.#password = password;
		this.debug = !!isDebug;

		// Ensure that channels is an array
		if( typeof channels === "string" || channels instanceof String ) {
			channels = [ channels as string ];
		}
		this.channels = channels || [ username ]; // Use username as the channel to join by default

		// Connect to the server
		this.#connect();
	}

	get #mainChannel() : string { return this.channels[ 0 ]; }
	get #isConnected() : boolean { return !!( this.#ws && this.#ws.readyState === this.#ws.OPEN ); }
	get version() : string { return "@VERSION"; }
	get latency() : number { return this.#latency; }
	get ws() : WebSocket | undefined { return this.#ws; }

	on( eventType : TwitchEventType, handler : ( context? : any ) => void ) {
		this.handlers[ eventType ] = handler;
	}

	say( message : string, channel? : string ) : void {
		if( !this.#ws ) { return; }
		if( !this.#isConnected ) { return; }

		sendChat( this.#ws, channel || this.#mainChannel, message );
	}

	reply( messageId : string, message : string, channel? : string ) : void {
		if( !this.#ws ) { return; }
		if( !this.#isConnected ) { return; }

		replyChat( this.#ws, channel || this.#mainChannel, messageId, message );
	}

	join( channel : string | string[] ) : void {
		if( !this.#ws ) { return; }
		if( !this.#isConnected ) { return; }

		joinChannel( this.#ws, channel );
		// TODO: add channel to this.channels
	}

	leave( channel : string ) : void {
		if( !this.#ws ) { return; }
		if( !this.#isConnected ) { return; }

		leaveChannel( this.#ws, channel );
		// TODO: remove channel from this.channels
	}

	deleteMessage( messageId : string, channel? : string ) : void {
		if( !this.#ws ) { return; }
		if( !this.#isConnected ) { return; }

		// TODO: This requires an API call
		// https://dev.twitch.tv/docs/api/reference/#delete-chat-messages
	}

	simulateIRCMessage( message : string ) : void {
		if( !this.#ws ) { return; }
		if( !this.#isConnected ) { return; }

		this.#onMessage( { "data": message } as MessageEvent );
	}

	#connect() {
		if( this.#isConnected ) { return; } // Already connected

		const TwitchServerWSS = "wss://irc-ws.chat.twitch.tv:443";
		// const TwitchServerWS = "ws://irc-ws.chat.twitch.tv:80";

		this.#ws = createWebSocket( TwitchServerWSS, "irc" );
		this.#ws.onopen = () => { this.#onOpen(); };
		this.#ws.onmessage = ( event ) => { this.#onMessage( event ); };
		this.#ws.onerror = ( event ) => { this.#onError( event ); };
		this.#ws.onclose = ( event ) => { this.#onClose( event ); };
	}

	#onOpen() {
		if( !this.#ws ) { return; }
		if( !this.#isConnected ) { return; }

		requestCapabilities( this.#ws );
		authenticate( this.#ws, this.#username, this.#password );
	}

	#onError( event : Event ) {
		console.error( "ERROR", event );
	}

	#onClose( event : Event ) {
		console.info( "CLOSE", event );
		if( this.#pingTimer ) {
			clearInterval( this.#pingTimer );
		}
	}

	#ping() {
		if( !this.#ws ) { return; }
		if( !this.#isConnected ) { return; }

		this.#pingTime = Date.now();
		ping( this.#ws );
	}

	#handleSpecialEvents( message : ProcessedMessage ) {
		if( !this.#ws ) { return; }
		if( !this.#isConnected ) { return; }

		switch( message.type ) {
		case TwitchEventType.Connect:
			this.#username = message.data.username;
			// Setup the keep-alive ping timer
			if( this.#pingTimer ) {
				clearInterval( this.#pingTimer );
			}
			this.#pingTimer = setInterval( () => {
				this.#ping();
			}, 60000 );
			// Get the base hostname from the url
			const hostUrl = new URL( this.#ws.url );
			message.data[ "address" ] = hostUrl.host;
			message.data[ "port" ] = hostUrl.protocol === "wss:" ? 443 : 80;
			message.data[ "isFirstConnect" ] = this.reconnects === 0;

			// Join the channels
			joinChannel( this.#ws, this.channels );
			break;
		case TwitchEventType.Ping:
			pong( this.#ws );
			break;
		case TwitchEventType.Pong:
			// Calculate and attach latency to the data
			message.data = message.data || {};
			this.#latency = message.data[ "latency" ] = ( Date.now() - this.#pingTime ); // Latency in milliseconds
			break;
		case TwitchEventType.RoomState:
			// Save ChatMode for the room at the first message and then diff the notifications afterwards
			// e.g. emoteOnly & followersOnly are both sent in the initial message but then enabling/disabling emoteOnly doesn't send the followersOnly mode flag
			this.chatModes[ message.data.channel ] = {
				...this.chatModes[ message.data.channel ],
				...message.data,
			};
			// TODO: delete chatMode when leaving a channel
			if( this.handlers[ TwitchEventType.ChatMode ] ) {
				this.handlers[ TwitchEventType.ChatMode ]!( this.chatModes[ message.data.channel ] );
			}
			break;
		// case TwitchEventType.Reconnect:
		// 	this.#connect();
		// 	break;
		// case TwitchEventType.Join:
		// 	if( message.channel ) {
		// 		this.channels.push( message.channel );
		// 	}
		// 	break;
		case TwitchEventType.Error:
			this.#ws.close();
			break;
		case TwitchEventType.Whisper:
			// Add the self flag to the messageData
			message.data.self = message.data.username === this.#username;
			break;
		case TwitchEventType.Chat:
			// Add the self flag to the messageData
			message.data.self = message.data.username === this.#username;
			// Check if there is a reply handler and this is a reply message
			if( this.handlers[ TwitchEventType.Reply ] && message.data.extra[ "reply-parent-msg-id" ] ) {
				this.handlers[ TwitchEventType.Reply ]!( {
					...message.data,
					parentId: message.data.extra[ "reply-parent-msg-id" ],
					parentUserId: message.data.extra[ "reply-parent-user-id" ],
					parentUser: message.data.extra[ "reply-parent-user-login" ],
					parentMessage: message.data.extra[ "reply-parent-msg-body" ],
					parentDisplayName: message.data.extra[ "reply-parent-display-name" ] || message.data.extra[ "reply-parent-user-login" ],
				} );
			}
			break;
		}
	}

	#onMessage( event : MessageEvent<any> ) {
		if( !this.#ws ) { return; }
		if( !this.#isConnected ) { return; }

		const parts = event.data.trim().split( `\r\n` );
		for( const str of parts ) {
			// console.debug( str );
			const message = processMessage( parseMessage( str ) );
			if( message && message.type !== TwitchEventType.None ) {
				// console.log( message );
				// Handle special events
				this.#handleSpecialEvents( message );

				// Send the event to handlers
				if( this.handlers[ message.type ] ) {
					this.handlers[ message.type ]!( message.data );
				}
				// Also send to the "all" event handler if it exists
				if( this.handlers[ TwitchEventType.All ] ) {
					this.handlers[ TwitchEventType.All ]!( {
						event: message.type,
						...message.data,
					} );
				}
				// console.debug( message );
			}
		}
	}

	destroy() {
		if( this.#ws && this.#ws.readyState !== this.#ws.CLOSED ) {
			this.#ws.close();
		}
	}
}
