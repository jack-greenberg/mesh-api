import fetch from "node-fetch";
import { getLos } from "./los";
import { requestMessage } from "../slack";
import { performQuery } from ".";

const getRequestsQuery = `SELECT
	requests.*,
	buildings.address AS address,
	to_json(members) AS member,
	json_agg(json_build_object('id', panoramas.id, 'url', panoramas.url, 'date', panoramas.date)) AS panoramas
FROM
	requests
	LEFT JOIN buildings ON requests.building_id = buildings.id
	LEFT JOIN members ON requests.member_id = members.id
	LEFT JOIN panoramas ON requests.id = panoramas.request_id
GROUP BY
	requests.id,
	buildings.id,
	members.id
ORDER BY
	date DESC`;

const getRequestQuery = `SELECT
	requests.*,
	to_json(buildings) AS building,
	to_json(members) AS member,
	json_agg(json_build_object('id', panoramas.id, 'url', panoramas.url, 'date', panoramas.date)) AS panoramas
FROM
	requests
	JOIN buildings ON requests.building_id = buildings.id
	JOIN members ON requests.member_id = members.id
	LEFT JOIN panoramas ON requests.id = panoramas.request_id
WHERE
	requests.id = $1
GROUP BY
	requests.id,
	buildings.id,
	members.id`;

export async function getRequest(id) {
	if (!Number.isInteger(parseInt(id, 10))) throw new Error("Bad params");
	const [request] = await performQuery(getRequestQuery, [id]);
	if (!request) throw new Error("Not found");
	return request;
}

export async function getRequests() {
	return performQuery(getRequestsQuery);
}

export async function createRequest(request) {
	const {
		name,
		email,
		phone,
		address,
		lat = 0,
		lng = 0,
		alt = 0,
		bin,
		roofAccess
	} = request;

	// Look up or create member
	let members = await performQuery("SELECT * FROM members WHERE email = $1", [
		email
	]);
	if (!members.length) {
		members = await performQuery(
			"INSERT INTO members (name, email, phone) VALUES ($1, $2, $3) RETURNING *",
			[name, email, phone]
		);
	}
	const [member] = members;

	// Look up or create building
	let buildings = await performQuery(
		"SELECT * FROM buildings WHERE address = $1",
		[address]
	);
	if (!buildings.length) {
		buildings = await performQuery(
			"INSERT INTO buildings (address, lat, lng, alt, bin) VALUES ($1, $2, $3, $4, $5) RETURNING *",
			[address, lat, lng, alt, bin]
		);
	}
	const [building] = buildings;

	const now = new Date();

	// Insert request
	const [newRequest] = await performQuery(
		"INSERT INTO requests (date, roof_access, member_id, building_id) VALUES ($1, $2, $3, $4) RETURNING *",
		[now, roofAccess, member.id, building.id]
	);

	// This doesn't work because osTicket returns the external ticket id
	// which doesn't do anything... we need the internal ticket id.
	// 	const ticketId = await createTicket(newRequest, building, member);
	//
	// 	const [updatedRequest] = await performQuery(
	// 		"UPDATE requests SET osticket_id = $1 WHERE id = $2 RETURNING *",
	// 		[ticketId, newRequest.id]
	// 	);

	await requestMessage(request, newRequest, building, member);

	return newRequest;
}

// https://docs.osticket.com/en/latest/Developer%20Documentation/API/Tickets.html
async function createTicket(request, building, member) {
	const { id, date, roofAccess } = request;
	const { address, lat, lng } = building;
	const { name, email, phone } = member;

	const subject = `NYC Mesh Install`;
	const message = address;

	const url = "http://devsupport.nycmesh.net/api/http.php/tickets.json";
	const response = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-API-Key": process.env.OSTICKET_API_KEY
		},
		body: JSON.stringify({
			email,
			name,
			subject,
			message,
			phone
		})
	});

	const text = await response.text();
	if (response.status !== 201) {
		throw text;
	}

	return text; // external ticket id of the newly-created ticket
}