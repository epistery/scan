# epistery-scan

Epistery Scan is like etherscan, but host focused rather than chain specific.

The server has a list of agent contracts to track, along with the constracts the
y may spawn and all the events created. Contracts may reside on diferent chains.
 By stashing the event data as it happens and routinely refreshing, the server c
an provide fast and robust queries for all the agents operating in the epistery 
ecosystem.

Epistery Scan can play a further role as a message router. Many epistery objects
 anticipate messaging each other through chain transactions. Epistery Scan can t
ranslate that system into the real world of instant messaging.
